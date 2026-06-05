/**
 * OAuth device flow HTTP handlers (new model: authStore + provisionUser).
 *
 * Endpoints:
 * - POST /api/v1/auth/device/code      - CLI initiates device flow
 * - POST /api/v1/auth/device/token     - CLI polls for token
 * - GET  /api/v1/auth/device/verify    - User enters code (HTML form)
 * - POST /api/v1/auth/device/verify    - User submits code -> OAuth redirect
 * - GET  /api/v1/auth/callback/:provider - OAuth callback -> consent page
 * - POST /api/v1/auth/device/approve   - User approves/denies (consent)
 */

import type { AuthStore, OAuthProvider } from "@memory.build/auth";
import { type CoreStore, coreStore } from "@memory.build/engine/core";
import { info, reportError } from "@pydantic/logfire-node";
import type { Sql } from "postgres";
import { buildAuthUrl, exchangeCode, fetchUserInfo } from "../auth/providers";
import { provisionUser } from "../provision";
import type { RouteParams } from "../router";
import { error, html, json } from "../util/response";

/** Min CLI poll interval (seconds) — matches poll_device's default. */
const POLL_INTERVAL_SECONDS = 5;

/**
 * Context for the auth handlers. `auth` is bound to the auth schema; `db` +
 * schema names are for provisionUser's atomic cross-schema transaction.
 */
export interface AuthHandlerContext {
  auth: AuthStore;
  db: Sql;
  authSchema: string;
  coreSchema: string;
  baseUrl: string;
}

function isProvider(p: string | undefined): p is OAuthProvider {
  return p === "google" || p === "github";
}

/**
 * POST /api/v1/auth/device/code — CLI initiates the device flow.
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
  if (!isProvider(body.provider)) {
    return error(
      "Invalid provider. Must be 'google' or 'github'",
      400,
      "INVALID_PROVIDER",
    );
  }

  const device = await ctx.auth.createDeviceAuth(body.provider);
  return json({
    deviceCode: device.deviceCode,
    userCode: device.userCode,
    verificationUri: `${ctx.baseUrl}/api/v1/auth/device/verify`,
    expiresIn: device.expiresIn,
    interval: POLL_INTERVAL_SECONDS,
  });
}

/**
 * POST /api/v1/auth/device/token — CLI polls for the session token.
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

  const poll = await ctx.auth.pollDevice(deviceCode);
  switch (poll.status) {
    case "slow_down":
      return json({ error: "slow_down" }, 400);
    case "expired":
      return json({ error: "expired_token" }, 400);
    case "denied":
      await ctx.auth.deleteDevice(deviceCode);
      return json({ error: "access_denied" }, 400);
    case "pending":
      return json({ error: "authorization_pending" }, 400);
    case "approved": {
      if (!poll.userId) {
        return error("Approved device has no user", 500, "INTERNAL_ERROR");
      }
      const user = await ctx.auth.getUser(poll.userId);
      if (!user) {
        return error("User not found", 500, "INTERNAL_ERROR");
      }
      const session = await ctx.auth.createSession(poll.userId);
      await ctx.auth.deleteDevice(deviceCode);
      return json({
        sessionToken: session.token,
        identity: { id: user.id, email: user.email, name: user.name },
      });
    }
  }
}

/**
 * GET /api/v1/auth/device/verify — the page where the user enters their code.
 */
export function deviceVerifyGetHandler(
  _request: Request,
  _ctx: AuthHandlerContext,
): Response {
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in to Memory Engine</title>
  ${PAGE_STYLE}
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
  // The form POSTs to self, then we 302 to the OAuth provider; browsers enforce
  // form-action across the redirect chain, so whitelist the provider origins.
  const csp =
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com https://github.com";
  return html(htmlContent, 200, csp);
}

/**
 * POST /api/v1/auth/device/verify — user submitted a code; redirect to OAuth.
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

  const device = await ctx.auth.getDeviceByUserCode(userCode);
  if (!device) {
    return html(errorPage("Invalid or expired code. Please try again."), 400);
  }

  const redirectUri = `${ctx.baseUrl}/api/v1/auth/callback/${device.provider}`;
  const authUrl = buildAuthUrl(device.provider, device.oauthState, redirectUri);
  return new Response(null, { status: 302, headers: { Location: authUrl } });
}

/**
 * Redeem pending space invitations for a just-verified login email: join the
 * user to each invited space (owner@home + the per-invite share level).
 * Idempotent, and best-effort — a redemption failure is logged and swallowed so
 * it never fails the sign-in (the next login retries). Returns the number of
 * spaces joined. The caller MUST have verified the user owns this email first
 * (invitations are email-keyed; redeeming for an unverified email would let a
 * caller claim invites sent to an address they don't control).
 */
export async function redeemInvitationsForVerifiedLogin(
  core: CoreStore,
  userId: string,
  email: string,
): Promise<number> {
  try {
    const joined = await core.redeemSpaceInvitations(userId, email);
    if (joined.length > 0) {
      info("Redeemed space invitations", { email, spaces: joined.length });
    }
    return joined.length;
  } catch (err) {
    reportError(
      "Invitation redemption failed (continuing sign-in)",
      err as Error,
      { email },
    );
    return 0;
  }
}

/**
 * GET /api/v1/auth/callback/:provider — OAuth callback.
 *
 * Resolves the user (account → verified email → provision), redeems pending
 * space invitations for the verified email, binds them to the device (status
 * stays 'pending'), and shows the consent page. Authorization only happens when
 * the human approves (POST /device/approve).
 */
export async function oauthCallbackHandler(
  request: Request,
  params: RouteParams,
  ctx: AuthHandlerContext,
): Promise<Response> {
  if (!isProvider(params.provider)) {
    return html(errorPage("Unknown OAuth provider"), 400);
  }
  const provider = params.provider;

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const oauthState = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    const errorDesc = url.searchParams.get("error_description") || errorParam;
    if (oauthState) {
      const device = await ctx.auth.getDeviceByOAuthState(oauthState);
      if (device) await ctx.auth.denyDevice(device.deviceCode);
    }
    return html(errorPage(`OAuth error: ${errorDesc}`), 400);
  }
  if (!code || !oauthState) {
    return html(errorPage("Missing code or state parameter"), 400);
  }

  const device = await ctx.auth.getDeviceByOAuthState(oauthState);
  if (!device) {
    return html(
      errorPage("Invalid or expired session. Please restart the sign-in."),
      400,
    );
  }

  const redirectUri = `${ctx.baseUrl}/api/v1/auth/callback/${provider}`;
  try {
    const tokens = await exchangeCode(provider, code, redirectUri);
    const userInfo = await fetchUserInfo(provider, tokens.accessToken);

    // Reject unverified emails — the gate that prevents account-takeover via a
    // provider asserting someone else's address.
    if (!userInfo.emailVerified) {
      await ctx.auth.denyDevice(device.deviceCode);
      return html(
        errorPage(
          `Your ${provider} email (${userInfo.email}) is not verified. Verify it with ${provider} and try again.`,
        ),
        400,
      );
    }

    // Resolve the user: existing account → existing verified email → new user.
    let userId: string;
    const account = await ctx.auth.getAccountByProvider(
      provider,
      userInfo.providerAccountId,
    );
    if (account) {
      userId = account.userId;
    } else {
      const byEmail = await ctx.auth.getUserByEmail(userInfo.email);
      if (byEmail) {
        // verified (gated above) → safe to link this provider to the user
        userId = byEmail.id;
        await ctx.auth.upsertAccount(
          userId,
          provider,
          userInfo.providerAccountId,
        );
      } else {
        const result = await provisionUser(
          ctx.db,
          { auth: ctx.authSchema, core: ctx.coreSchema },
          {
            email: userInfo.email,
            name: userInfo.name,
            provider,
            accountId: userInfo.providerAccountId,
            emailVerified: true,
          },
        );
        userId = result.userId;
        info("Provisioned new user", { email: userInfo.email });
      }
    }

    // The email is verified (gated above) → proven owned, so redeem any pending
    // space invitations sent to it (the user joins each invited space).
    await redeemInvitationsForVerifiedLogin(
      coreStore(ctx.db, ctx.coreSchema),
      userId,
      userInfo.email,
    );

    // Bind the user; the device stays 'pending' until the human consents.
    await ctx.auth.bindDeviceUser(device.deviceCode, userId);
    return html(
      consentPage(userInfo.email, device.userCode, provider, oauthState),
      200,
      CONSENT_CSP,
    );
  } catch (err) {
    reportError("OAuth callback error", err as Error);
    return html(errorPage("Authentication failed. Please try again."), 500);
  }
}

/**
 * POST /api/v1/auth/device/approve — the human approves (or denies) the device.
 * The browser only ever carries the oauth_state, never the device_code.
 */
export async function deviceApproveHandler(
  request: Request,
  ctx: AuthHandlerContext,
): Promise<Response> {
  const formData = await request.formData();
  const oauthState = formData.get("oauth_state");
  const decision = formData.get("decision");
  if (typeof oauthState !== "string") {
    return html(errorPage("Missing state."), 400);
  }

  const device = await ctx.auth.getDeviceByOAuthState(oauthState);
  if (!device) {
    return html(
      errorPage("Invalid or expired session. Please restart the sign-in."),
      400,
    );
  }

  if (decision === "deny") {
    await ctx.auth.denyDevice(device.deviceCode);
    return html(deniedPage());
  }

  const ok = await ctx.auth.approveDevice(device.deviceCode);
  if (!ok) {
    return html(
      errorPage("This request was already handled or has expired."),
      400,
    );
  }
  return html(successPage());
}

// =============================================================================
// HTML pages
// =============================================================================

const PAGE_STYLE = `<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; background: #f5f5f5; padding: 20px;
    }
    .container {
      background: white; padding: 40px; border-radius: 12px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 420px; width: 100%;
      text-align: center;
    }
    h1 { font-size: 24px; margin-bottom: 8px; color: #333; }
    p { color: #666; margin-bottom: 24px; }
    code { background: #f0f0f0; padding: 2px 8px; border-radius: 6px; font-size: 18px; letter-spacing: 2px; }
    input {
      width: 100%; padding: 16px; font-size: 24px; text-align: center;
      letter-spacing: 4px; border: 2px solid #ddd; border-radius: 8px;
      text-transform: uppercase; margin-bottom: 16px;
    }
    input:focus { outline: none; border-color: #0066cc; }
    button {
      width: 100%; padding: 16px; font-size: 16px; color: white;
      border: none; border-radius: 8px; cursor: pointer; margin-bottom: 12px;
    }
    .primary { background: #0066cc; } .primary:hover { background: #0052a3; }
    .secondary { background: #888; } .secondary:hover { background: #666; }
    .checkmark { font-size: 64px; margin-bottom: 16px; }
    a { display: inline-block; padding: 12px 24px; background: #0066cc; color: white; text-decoration: none; border-radius: 8px; }
  </style>`;

/** Consent page: shown after OAuth; the user explicitly approves the device. */
function consentPage(
  email: string,
  userCode: string,
  provider: string,
  oauthState: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Approve sign-in - Memory Engine</title>
  ${PAGE_STYLE}
</head>
<body>
  <div class="container">
    <h1>Approve this sign-in?</h1>
    <p>A device is requesting access to your memory as
       <strong>${escapeHtml(email)}</strong> (via ${escapeHtml(provider)}).<br><br>
       Only approve if you started this and the code below matches the one your
       device shows: <code>${escapeHtml(userCode)}</code></p>
    <form method="POST" action="/api/v1/auth/device/approve">
      <input type="hidden" name="oauth_state" value="${escapeHtml(oauthState)}">
      <button class="primary" type="submit" name="decision" value="approve">Approve</button>
      <button class="secondary" type="submit" name="decision" value="deny">Deny</button>
    </form>
  </div>
</body>
</html>`;
}

const CONSENT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'";

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error - Memory Engine</title>
  ${PAGE_STYLE}
</head>
<body>
  <div class="container">
    <h1 style="color:#cc0000">Error</h1>
    <p>${escapeHtml(message)}</p>
    <a href="/api/v1/auth/device/verify">Try Again</a>
  </div>
</body>
</html>`;
}

function successPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Success - Memory Engine</title>
  ${PAGE_STYLE}
</head>
<body>
  <div class="container">
    <div class="checkmark" style="color:#00aa00">✓</div>
    <h1>You're signed in!</h1>
    <p>You can close this window and return to your CLI.</p>
  </div>
</body>
</html>`;
}

function deniedPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Denied - Memory Engine</title>
  ${PAGE_STYLE}
</head>
<body>
  <div class="container">
    <h1>Request denied</h1>
    <p>No access was granted. You can close this window.</p>
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
