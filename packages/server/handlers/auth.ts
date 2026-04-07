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

import type { AccountsDB } from "@memory-engine/accounts";
import {
  authorizeDevice,
  checkPollRateLimit,
  cleanupDeviceState,
  createDeviceAuthorization,
  getDeviceStateByDeviceCode,
  getDeviceStateByOAuthState,
  getDeviceStateByUserCode,
} from "../auth/device-flow";
import { buildAuthUrl, exchangeCode, fetchUserInfo } from "../auth/providers";
import type { OAuthProvider } from "../auth/types";
import type { RouteParams } from "../router";
import { error, html, json } from "../util/response";

/**
 * Context needed for auth handlers.
 */
export interface AuthHandlerContext {
  /** AccountsDB instance */
  db: AccountsDB;
  /** Base URL for callbacks (e.g., "https://memoryengine.dev") */
  baseUrl: string;
}

/** Global context - set during server initialization */
let authContext: AuthHandlerContext | null = null;

/**
 * Initialize auth handlers with context.
 */
export function initAuthHandlers(context: AuthHandlerContext): void {
  authContext = context;
}

/**
 * Get auth context, throwing if not initialized.
 */
function getContext(): AuthHandlerContext {
  if (!authContext) {
    throw new Error("Auth handlers not initialized");
  }
  return authContext;
}

/**
 * POST /api/v1/auth/device/code
 *
 * CLI initiates device flow.
 * Request: { provider: "google" }
 * Response: { deviceCode, userCode, verificationUri, expiresIn, interval }
 */
export async function deviceCodeHandler(request: Request): Promise<Response> {
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

  const ctx = getContext();
  const auth = createDeviceAuthorization(provider);

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
export async function deviceTokenHandler(request: Request): Promise<Response> {
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

  // Check if device code exists
  const state = getDeviceStateByDeviceCode(deviceCode);
  if (!state) {
    return json({ error: "expired_token" }, 400);
  }

  // Check rate limit
  if (checkPollRateLimit(deviceCode)) {
    return json({ error: "slow_down" }, 400);
  }

  // Check if denied
  if (state.denied) {
    cleanupDeviceState(deviceCode);
    return json({ error: "access_denied" }, 400);
  }

  // Check if authorized
  if (!state.authorizedIdentityId) {
    return json({ error: "authorization_pending" }, 400);
  }

  // Get identity and create session
  const ctx = getContext();
  const identity = await ctx.db.getIdentity(state.authorizedIdentityId);
  if (!identity) {
    return error("Identity not found", 500, "INTERNAL_ERROR");
  }

  // Create session
  const sessionResult = await ctx.db.createSession({
    identityId: identity.id,
  });

  // Cleanup device state
  cleanupDeviceState(deviceCode);

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

  return html(htmlContent);
}

/**
 * POST /api/v1/auth/device/verify
 *
 * User submits code. If valid, redirect to OAuth provider.
 */
export async function deviceVerifyPostHandler(
  request: Request,
): Promise<Response> {
  const formData = await request.formData();
  const userCode = formData.get("user_code");

  if (!userCode || typeof userCode !== "string") {
    return html(errorPage("Please enter a code"), 400);
  }

  // Find device state
  const state = getDeviceStateByUserCode(userCode);
  if (!state) {
    return html(errorPage("Invalid or expired code. Please try again."), 400);
  }

  // Redirect to OAuth provider
  const ctx = getContext();
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
): Promise<Response> {
  const provider = params.provider as OAuthProvider;
  if (provider !== "google" && provider !== "github") {
    return html(errorPage("Unknown OAuth provider"), 400);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  // Check for OAuth error
  if (errorParam) {
    const errorDesc = url.searchParams.get("error_description") || errorParam;
    // If we have state, mark device as denied
    if (state) {
      const deviceState = getDeviceStateByOAuthState(state);
      if (deviceState) {
        deviceState.denied = true;
      }
    }
    return html(errorPage(`OAuth error: ${errorDesc}`), 400);
  }

  if (!code || !state) {
    return html(errorPage("Missing code or state parameter"), 400);
  }

  // Find device state by OAuth state
  const deviceState = getDeviceStateByOAuthState(state);
  if (!deviceState) {
    return html(
      errorPage(
        "Invalid or expired session. Please restart the sign-in process.",
      ),
      400,
    );
  }

  const ctx = getContext();
  const redirectUri = `${ctx.baseUrl}/api/v1/auth/callback/${provider}`;

  try {
    // Exchange code for tokens
    const tokens = await exchangeCode(provider, code, redirectUri);

    // Fetch user info
    const userInfo = await fetchUserInfo(provider, tokens.accessToken);

    // Find or create identity
    let identity = await ctx.db.getIdentityByEmail(userInfo.email);
    if (!identity) {
      // Create new identity
      identity = await ctx.db.createIdentity({
        email: userInfo.email,
        name: userInfo.name,
      });
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
    authorizeDevice(deviceState.deviceCode, identity.id);

    // Show success page
    return html(successPage());
  } catch (err) {
    console.error("OAuth callback error:", err);
    return html(errorPage("Authentication failed. Please try again."), 500);
  }
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
