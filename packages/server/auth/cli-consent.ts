import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  sessionMiddleware,
} from "better-auth/api";
import { z } from "zod";

const CLI_SCOPES = new Set(["openid", "profile", "email", "offline_access"]);

function invalidRequest(message: string): never {
  throw new APIError("BAD_REQUEST", {
    error: "invalid_request",
    error_description: message,
  });
}

async function readConsentQuery(
  query: string,
  secret: string,
  clientId: string,
) {
  if (!(await verifyOAuthQueryParams(query, secret))) {
    invalidRequest(
      "This authorization request is invalid or has expired. Start me login again.",
    );
  }
  const params = new URLSearchParams(query);
  for (const key of [
    "client_id",
    "redirect_uri",
    "scope",
    "response_type",
    "prompt",
    "code_challenge",
    "code_challenge_method",
    "state",
  ]) {
    if (params.getAll(key).length > 1)
      invalidRequest("Duplicate authorization parameter.");
  }
  if (
    params.get("client_id") !== clientId ||
    params.get("response_type") !== "code" ||
    params.get("code_challenge_method") !== "S256" ||
    !params.get("code_challenge") ||
    !params.get("prompt")?.split(/\s+/).includes("consent") ||
    params.has("claims") ||
    params.has("resource")
  ) {
    invalidRequest("Unsupported CLI authorization request.");
  }
  const scopes = (params.get("scope") ?? "").split(/\s+/).filter(Boolean);
  if (scopes.some((scope) => !CLI_SCOPES.has(scope))) {
    invalidRequest("Unsupported CLI authorization scope.");
  }
  let redirect: URL;
  try {
    redirect = new URL(params.get("redirect_uri") ?? "");
  } catch {
    invalidRequest("Invalid CLI callback address.");
  }
  if (
    redirect.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(redirect.hostname) ||
    redirect.username ||
    redirect.password ||
    redirect.hash
  ) {
    invalidRequest("Invalid CLI callback address.");
  }
  return { redirect, scopes };
}

function requireConsent(
  params: Record<string, unknown> | undefined,
  clientId: string,
) {
  if (params?.client_id !== clientId) return params;
  if (params.prompt !== undefined && typeof params.prompt !== "string")
    return params;
  const prompts =
    (params.prompt as string | undefined)?.split(/\s+/).filter(Boolean) ?? [];
  if (prompts.includes("none")) {
    throw new APIError("BAD_REQUEST", {
      error: "consent_required",
      error_description:
        "CLI authorization requires explicit browser approval.",
    });
  }
  return { ...params, prompt: [...new Set([...prompts, "consent"])].join(" ") };
}

/** Require approval on each authorization dispatch, except native consent completion. */
export function cliConsentBefore(
  clientId: string,
  basePath: string,
  secret: string,
) {
  return createAuthMiddleware(async (ctx) => {
    if (
      ctx.path === "/oauth2/consent" &&
      typeof ctx.body?.oauth_query === "string"
    ) {
      const query = new URLSearchParams(ctx.body.oauth_query);
      if (query.get("client_id") === clientId) {
        await readConsentQuery(ctx.body.oauth_query, secret, clientId);
        const session = await getSessionFromCtx(ctx);
        if (!session)
          throw new APIError("UNAUTHORIZED", {
            message: "Sign in again to approve this request.",
          });
        if (ctx.headers?.get("X-Me-Consent-Account") !== session.user.id) {
          throw new APIError("FORBIDDEN", {
            message: "Your signed-in account changed. Start me login again.",
          });
        }
      }
    }
    if (ctx.path !== "/oauth2/authorize") return;
    // Only the real consent endpoint can complete an approved request.
    if (
      ctx.request?.method === "POST" &&
      new URL(ctx.request.url).pathname === `${basePath}/oauth2/consent` &&
      ctx.body?.accept === true
    )
      return;
    return {
      context: {
        query: requireConsent(ctx.query, clientId),
        body: requireConsent(ctx.body, clientId),
      },
    };
  });
}

/** Return validated request details without issuing an authorization code. */
export function cliConsentPage(clientId: string, secret: string) {
  return {
    id: "cli-consent-page",
    endpoints: {
      cliConsentDetails: createAuthEndpoint(
        "/oauth2/cli-consent-details",
        {
          method: "POST",
          body: z.object({ oauth_query: z.string() }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          ctx.setHeader("Cache-Control", "no-store");
          const { redirect, scopes } = await readConsentQuery(
            ctx.body.oauth_query,
            secret,
            clientId,
          );
          const client = await ctx.context.adapter.findOne<{
            name: string;
            disabled?: boolean;
            redirectUris: string[];
          }>({
            model: "oauthClient",
            where: [{ field: "clientId", value: clientId }],
          });
          if (!client || client.disabled)
            invalidRequest("The CLI client is unavailable.");
          const registered = client.redirectUris.some((uri) => {
            const expected = new URL(uri);
            return (
              expected.protocol === redirect.protocol &&
              expected.hostname === redirect.hostname &&
              expected.pathname === redirect.pathname &&
              expected.search === redirect.search
            );
          });
          if (!registered)
            invalidRequest("The CLI callback address is not registered.");
          return ctx.json({
            user: {
              id: ctx.context.session.user.id,
              email: ctx.context.session.user.email,
            },
            clientName: client.name,
            redirectUri: redirect.href,
            scopes,
          });
        },
      ),
    },
  };
}
