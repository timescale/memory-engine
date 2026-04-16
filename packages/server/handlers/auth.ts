/**
 * OAuth device flow HTTP handlers.
 *
 * Endpoints:
 * - POST /api/v1/auth/device/code     - CLI initiates device flow
 * - POST /api/v1/auth/device/token    - CLI polls for token
 * - GET  /api/v1/auth/device/verify   - User enters code (HTML form)
 * - POST /api/v1/auth/device/verify   - User submits code
 * - GET  /api/v1/auth/callback/:provider - OAuth callback
 */

import type { AccountsDB, Identity } from "@memory.build/accounts";
import { type EngineConfig, provisionEngine } from "@memory.build/engine";
import { info, reportError } from "@pydantic/logfire-node";
import type { SQL } from "bun";
import {
  authorizeDevice,
  checkPollRateLimit,
  cleanupDeviceState,
  createDeviceAuthorization,
  denyDevice,
  getDeviceStateByDeviceCode,
  getDeviceStateByOAuthState,
  getDeviceStateByUserCode,
} from "../auth/device-flow";
import { buildAuthUrl, exchangeCode, fetchUserInfo } from "../auth/providers";
import type { OAuthProvider } from "../auth/types";
import { embeddingConstants } from "../config";
import type { RouteParams } from "../router";
import { error, html, json } from "../util/response";

/**
 * Context needed for auth handlers.
 */
export interface AuthHandlerContext {
  /** AccountsDB instance */
  db: AccountsDB;
  /** Base URL for callbacks (e.g., "https://memory.build") */
  baseUrl: string;
  /** Engine database pool (for provisioning default engine on signup) */
  engineSql: SQL;
  /** Application version for migration tracking */
  appVersion: string;
}

/**
 * POST /api/v1/auth/device/code
 *
 * CLI initiates device flow.
 * Request: { provider: "google" }
 * Response: { deviceCode, userCode, verificationUri, expiresIn, interval }
 */
export async function deviceCodeHandler(
  request: Request,
  ctx: AuthHandlerContext,
): Promise<Response> {
  if (request.method !== "POST") {
    return error("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  }

  let body: { provider?: string };
  try {
    body = (await request.json()) as { provider?: string };
  } catch {
    return error("Invalid JSON body", 400, "INVALID_REQUEST");
  }

  const provider = body.provider;
  if (provider !== "google" && provider !== "github") {
    return error(
      "Invalid provider. Must be 'google' or 'github'",
      400,
      "INVALID_PROVIDER",
    );
  }

  const auth = await createDeviceAuthorization(ctx.db, provider);

  return json({
    deviceCode: auth.deviceCode,
    userCode: auth.userCode,
    verificationUri: `${ctx.baseUrl}/api/v1/auth/device/verify`,
    expiresIn: auth.expiresIn,
    interval: auth.interval,
  });
}

/**
 * POST /api/v1/auth/device/token
 *
 * CLI polls for token.
 * Request: { deviceCode: "..." }
 * Response (pending): { error: "authorization_pending" }
 * Response (success): { sessionToken, identity: { id, email, name } }
 */
export async function deviceTokenHandler(
  request: Request,
  ctx: AuthHandlerContext,
): Promise<Response> {
  if (request.method !== "POST") {
    return error("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  }

  let body: { deviceCode?: string };
  try {
    body = (await request.json()) as { deviceCode?: string };
  } catch {
    return error("Invalid JSON body", 400, "INVALID_REQUEST");
  }

  const deviceCode = body.deviceCode;
  if (!deviceCode || typeof deviceCode !== "string") {
    return error("Missing deviceCode", 400, "INVALID_REQUEST");
  }

  // Check rate limit first (also updates last_poll timestamp)
  const tooFast = await checkPollRateLimit(ctx.db, deviceCode);
  if (tooFast) {
    return json({ error: "slow_down" }, 400);
  }

  // Check if device code exists
  const state = await getDeviceStateByDeviceCode(ctx.db, deviceCode);
  if (!state) {
    return json({ error: "expired_token" }, 400);
  }

  // Check if denied
  if (state.denied) {
    await cleanupDeviceState(ctx.db, deviceCode);
    return json({ error: "access_denied" }, 400);
  }

  // Check if authorized
  if (!state.identityId) {
    return json({ error: "authorization_pending" }, 400);
  }

  // Get identity and create session
  const identity = await ctx.db.getIdentity(state.identityId);
  if (!identity) {
    return error("Identity not found", 500, "INTERNAL_ERROR");
  }

  // Create session
  const sessionResult = await ctx.db.createSession({
    identityId: identity.id,
  });

  // Cleanup device state
  await cleanupDeviceState(ctx.db, deviceCode);

  return json({
    sessionToken: sessionResult.rawToken,
    identity: {
      id: identity.id,
      email: identity.email,
      name: identity.name,
    },
  });
}

/**
 * GET /api/v1/auth/device/verify
 *
 * User visits this page to enter their code.
 * Returns an HTML form.
 */
export async function deviceVerifyGetHandler(
  _request: Request,
  _ctx: AuthHandlerContext,
): Promise<Response> {
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in to Memory Engine</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      background: #f5f5f5;
      padding: 20px;
    }
    .container {
      background: white;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      max-width: 400px;
      width: 100%;
      text-align: center;
    }
    h1 { font-size: 24px; margin-bottom: 8px; color: #333; }
    p { color: #666; margin-bottom: 24px; }
    input {
      width: 100%;
      padding: 16px;
      font-size: 24px;
      text-align: center;
      letter-spacing: 4px;
      border: 2px solid #ddd;
      border-radius: 8px;
      text-transform: uppercase;
      margin-bottom: 16px;
    }
    input:focus { outline: none; border-color: #0066cc; }
    button {
      width: 100%;
      padding: 16px;
      font-size: 16px;
      background: #0066cc;
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
    }
    button:hover { background: #0052a3; }
    .error { color: #cc0000; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Sign in to Memory Engine</h1>
    <p>Enter the code shown in your CLI</p>
    <form method="POST" action="/api/v1/auth/device/verify">
      <input type="text" name="user_code" placeholder="XXXX-XXXX" 
             maxlength="9" required autocomplete="off" autofocus>
      <button type="submit">Continue</button>
    </form>
  </div>
</body>
</html>`;

  // The form POSTs to 'self', but the response is a 302 redirect to the
  // OAuth provider. Browsers enforce form-action on the full redirect chain,
  // so we must whitelist the OAuth provider origins here.
  const csp =
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com https://github.com";

  return html(htmlContent, 200, csp);
}

/**
 * POST /api/v1/auth/device/verify
 *
 * User submits code. If valid, redirect to OAuth provider.
 */
export async function deviceVerifyPostHandler(
  request: Request,
  ctx: AuthHandlerContext,
): Promise<Response> {
  const formData = await request.formData();
  const userCode = formData.get("user_code");

  if (!userCode || typeof userCode !== "string") {
    return html(errorPage("Please enter a code"), 400);
  }

  // Find device state
  const state = await getDeviceStateByUserCode(ctx.db, userCode);
  if (!state) {
    return html(errorPage("Invalid or expired code. Please try again."), 400);
  }

  // Redirect to OAuth provider
  const redirectUri = `${ctx.baseUrl}/api/v1/auth/callback/${state.provider}`;
  const authUrl = buildAuthUrl(state.provider, state.oauthState, redirectUri);

  return new Response(null, {
    status: 302,
    headers: { Location: authUrl },
  });
}

/**
 * GET /api/v1/auth/callback/:provider
 *
 * OAuth callback. Exchange code for tokens, create/link identity.
 */
export async function oauthCallbackHandler(
  request: Request,
  params: RouteParams,
  ctx: AuthHandlerContext,
): Promise<Response> {
  const provider = params.provider as OAuthProvider;
  if (provider !== "google" && provider !== "github") {
    return html(errorPage("Unknown OAuth provider"), 400);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const oauthState = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  // Check for OAuth error
  if (errorParam) {
    const errorDesc = url.searchParams.get("error_description") || errorParam;
    // If we have state, mark device as denied
    if (oauthState) {
      const deviceState = await getDeviceStateByOAuthState(ctx.db, oauthState);
      if (deviceState) {
        await denyDevice(ctx.db, deviceState.deviceCode);
      }
    }
    return html(errorPage(`OAuth error: ${errorDesc}`), 400);
  }

  if (!code || !oauthState) {
    return html(errorPage("Missing code or state parameter"), 400);
  }

  // Find device state by OAuth state
  const deviceState = await getDeviceStateByOAuthState(ctx.db, oauthState);
  if (!deviceState) {
    return html(
      errorPage(
        "Invalid or expired session. Please restart the sign-in process.",
      ),
      400,
    );
  }

  const redirectUri = `${ctx.baseUrl}/api/v1/auth/callback/${provider}`;

  try {
    // Exchange code for tokens
    const tokens = await exchangeCode(provider, code, redirectUri);

    // Fetch user info
    const userInfo = await fetchUserInfo(provider, tokens.accessToken);

    // Find or create identity
    let identity = await ctx.db.getIdentityByEmail(userInfo.email);
    if (!identity) {
      // Create new identity and provision personal account
      identity = await ctx.db.createIdentity({
        email: userInfo.email,
        name: userInfo.name,
      });
      await provisionPersonalAccount(ctx, identity);
    }

    // Link OAuth account (upserts if exists)
    await ctx.db.linkOAuthAccount({
      identityId: identity.id,
      provider,
      providerAccountId: userInfo.providerAccountId,
      email: userInfo.email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? undefined,
      tokenExpiresAt: tokens.expiresIn
        ? new Date(Date.now() + tokens.expiresIn * 1000)
        : undefined,
    });

    // Mark device as authorized
    await authorizeDevice(ctx.db, deviceState.deviceCode, identity.id);

    // Show success page
    return html(successPage());
  } catch (err) {
    reportError("OAuth callback error", err as Error);
    return html(errorPage("Authentication failed. Please try again."), 500);
  }
}

// =============================================================================
// Personal Account Provisioning
// =============================================================================

/**
 * Provision a personal account for a newly created identity.
 *
 * Creates a personal org (with the identity as owner) and a default
 * memory engine within that org. This runs during first login so the
 * user has an immediate, working environment.
 */
async function provisionPersonalAccount(
  ctx: AuthHandlerContext,
  identity: Identity,
): Promise<void> {
  const { db, engineSql, appVersion } = ctx;

  const org = await db.withTransaction(async (txDb) => {
    // Create personal org
    const newOrg = await txDb.createOrg({ name: "Personal" });

    // Add identity as owner
    await txDb.addMember(newOrg.id, identity.id, "owner");

    // Create default engine record
    const engine = await txDb.createEngine({
      orgId: newOrg.id,
      name: "default",
    });

    // Provision the engine schema in the engine database
    const engineConfig: EngineConfig = {
      embedding_dimensions: embeddingConstants.dimensions,
      bm25_text_config: engine.language,
    };

    try {
      await provisionEngine(
        engineSql,
        engine.slug,
        engineConfig,
        appVersion,
        engine.shardId,
      );
    } catch (err) {
      // Clean up partially-created schema
      const schema = `me_${engine.slug}`;
      try {
        await engineSql.begin(async (tx) => {
          await tx.unsafe(`set local pgdog.shard to ${engine.shardId}`);
          await tx.unsafe(`drop schema if exists ${schema} cascade`);
        });
      } catch {
        // Log but don't mask original error
      }
      throw err;
    }

    return newOrg;
  });

  info("Provisioned personal account", {
    email: identity.email,
    orgId: org.id,
  });
}

/**
 * Generate error HTML page.
 */
function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error - Memory Engine</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      background: #f5f5f5;
      padding: 20px;
    }
    .container {
      background: white;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      max-width: 400px;
      width: 100%;
      text-align: center;
    }
    h1 { font-size: 24px; margin-bottom: 16px; color: #cc0000; }
    p { color: #666; margin-bottom: 24px; }
    a {
      display: inline-block;
      padding: 12px 24px;
      background: #0066cc;
      color: white;
      text-decoration: none;
      border-radius: 8px;
    }
    a:hover { background: #0052a3; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Error</h1>
    <p>${escapeHtml(message)}</p>
    <a href="/api/v1/auth/device/verify">Try Again</a>
  </div>
</body>
</html>`;
}

/**
 * Generate success HTML page.
 */
function successPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Success - Memory Engine</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      background: #f5f5f5;
      padding: 20px;
    }
    .container {
      background: white;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      max-width: 400px;
      width: 100%;
      text-align: center;
    }
    h1 { font-size: 24px; margin-bottom: 16px; color: #00aa00; }
    p { color: #666; }
    .checkmark {
      font-size: 64px;
      margin-bottom: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="checkmark">✓</div>
    <h1>You're signed in!</h1>
    <p>You can close this window and return to your CLI.</p>
  </div>
</body>
</html>`;
}

/**
 * Escape HTML entities.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
