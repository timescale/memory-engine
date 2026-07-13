/**
 * me login [space] — authenticate, then pick the active space. Two flows:
 *
 *   - default: OAuth 2.1 auth-code + PKCE over a 127.0.0.1 loopback redirect
 *     (needs a browser on this machine).
 *   - `--device`: OAuth 2.0 Device Authorization Grant (RFC 8628) — show a URL +
 *     code to open on any device and poll for approval. For headless sandboxes
 *     (an agent harness with no local browser). Yields a better-auth session
 *     token (no refresh token) rather than an access/refresh pair.
 *
 * 1. Compatibility check (fail fast before the auth round-trip)
 * 2. Acquire tokens via the chosen flow (loopback or device)
 * 3. Store the token set for the server
 * 4. Fetch identity (whoami) and the caller's spaces
 * 5. Select the active space (the X-Me-Space the rest of the CLI is scoped to):
 *      - a [space] argument (slug or name) is honored if it matches
 *      - otherwise auto-select when the user has exactly one space
 *      - multiple → prompt (text) / report (json); zero → suggest `me space create`
 */
import * as clack from "@clack/prompts";
import type {
  MemberSpaceResponse,
  PendingInvitationResponse,
} from "@memory.build/protocol/user";
import { Command } from "commander";
import { CLIENT_VERSION, MIN_SERVER_VERSION } from "../../../version";
import { checkServerVersion, createUserClient, RpcError } from "../client.ts";
import { resolveServer, setActiveSpace, storeTokens } from "../credentials.ts";
import { pollDeviceToken, startDeviceAuthorization } from "../device.ts";
import { formatSpaceLabel } from "../identity.ts";
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  generateState,
  OAuthError,
  type OAuthTokens,
} from "../oauth.ts";
import { LoopbackError, runLoopbackAuth } from "../oauth-loopback.ts";
import { getOutputFormat, type OutputFormat, output } from "../output.ts";
import { rejectActAsAgentForSessionCommand } from "../util.ts";

/**
 * Attempt to open a URL in the user's default browser.
 * Fails silently — the user can always visit the URL manually.
 */
async function openBrowser(url: string): Promise<void> {
  try {
    const cmds: Record<string, string[]> = {
      darwin: ["open", url],
      linux: ["xdg-open", url],
      win32: ["cmd", "/c", "start", url],
    };
    const args = cmds[process.platform];
    if (args) {
      const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
      await proc.exited;
    }
  } catch {
    // Ignore — user will see the URL in the terminal
  }
}

/**
 * Match a [space] argument against the caller's spaces, by slug (exact) or name
 * (case-insensitive). Returns the match, or null when nothing/ambiguous matches.
 */
function matchSpace(
  spaces: MemberSpaceResponse[],
  input: string,
): MemberSpaceResponse | null {
  const bySlug = spaces.find((s) => s.slug === input);
  if (bySlug) return bySlug;
  const lower = input.toLowerCase();
  const byName = spaces.filter((s) => s.name.toLowerCase() === lower);
  return byName.length === 1 ? (byName[0] ?? null) : null;
}

interface LoginOptions {
  /** Force the browser to re-show the sign-in page (to switch accounts). */
  switch?: boolean;
  /** Use the device authorization grant (headless — no local browser needed). */
  device?: boolean;
  /** commander `--no-browser` → false; whether to auto-open a browser. */
  browser?: boolean;
}

export function createLoginCommand(): Command {
  return new Command("login")
    .description("authenticate with Memory Engine and select the active space")
    .argument("[space]", "space to activate after login (slug or name)")
    .option(
      "--switch",
      "force the browser to re-show the sign-in page (to switch accounts), even if it already has a session",
    )
    .option(
      "--device",
      "log in without a local browser (device authorization grant) — for headless sandboxes",
    )
    .option(
      "--no-browser",
      "don't open a browser automatically (device login); just print the URL and code",
    )
    .action(async (spaceArg: string | undefined, opts: LoginOptions, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const server = resolveServer(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);
      const forceSwitch = opts.switch === true;

      await rejectActAsAgentForSessionCommand("login", fmt);

      if (fmt === "text") {
        clack.intro("me login");
        if (forceSwitch) {
          clack.log.info(
            "Switching accounts: you'll be asked to sign in again in the browser.",
          );
        }
      }

      // --- Compatibility check (before the OAuth round-trip) ---
      try {
        await checkServerVersion({
          url: server,
          clientVersion: CLIENT_VERSION,
          minServerVersion: MIN_SERVER_VERSION,
        });
      } catch (error) {
        fail(error, fmt, server);
      }

      try {
        // Acquire tokens via the chosen flow. `--device` polls a device code
        // (headless, no local browser); otherwise the auth-code + PKCE loopback.
        const tokens = opts.device
          ? await authorizeViaDevice({
              server,
              fmt,
              openBrowser: opts.browser !== false,
            })
          : await authorizeViaLoopback({ server, fmt, forceSwitch });

        storeTokens(server, {
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          expires_at:
            tokens.expiresIn !== undefined
              ? Date.now() + tokens.expiresIn * 1000
              : undefined,
          scope: tokens.scope,
        });

        const user = createUserClient({
          url: server,
          token: tokens.accessToken,
        });
        const identity = await user.whoami();

        const interactive = fmt === "text" && Boolean(process.stdin.isTTY);

        // Surface invitations addressed to this email and (interactively) let the
        // user accept some before picking the active space, so a freshly-joined
        // space is offered. Best-effort — never break login over invitations.
        const pending = await fetchPendingInvites(user);
        const accepted =
          interactive && pending.length > 0
            ? await acceptInvitationsInteractive(user, pending)
            : new Set<string>();
        const remaining = pending.filter((i) => !accepted.has(i.invitationId));

        let { spaces } = await user.space.list();

        // Still no spaces (declined / nothing to accept) → offer a personal one.
        if (spaces.length === 0) {
          const created = await maybeCreateDefaultSpace(user, interactive);
          if (created) spaces = (await user.space.list()).spaces;
        }

        const active = await selectSpace(server, spaces, spaceArg, fmt);

        output(
          {
            server,
            identity,
            space: active,
            // Login always establishes an OAuth session (never an api key), so
            // the auth method is constant — surfaced for parity with `whoami`.
            auth: "session",
            pendingInvitations: remaining,
          },
          fmt,
          () => {
            clack.log.success(
              `Logged in as ${identity.name} (${identity.email})`,
            );
            clack.log.info("Auth:   session");
            clack.log.info(`Server: ${server}`);
            clack.log.info(`Web UI: ${server}`);
            if (active) {
              clack.log.info(`Space:  ${formatSpaceLabel(active)}`);
              clack.note(
                "Run 'me project init' at the root of a software development\nproject to set up its memory (space, capture, agent).",
                "Next step",
              );
            } else if (spaces.length === 0) {
              clack.log.info("No spaces yet. Run 'me space create <name>'.");
            } else {
              clack.log.info("Run 'me space use <space>' to select a space.");
            }
            if (remaining.length > 0) {
              clack.log.info(
                `You have ${remaining.length} pending invitation(s) — run 'me invite list'.`,
              );
            }
            clack.outro("Done!");
          },
        );
      } catch (error) {
        fail(error, fmt, server);
      }
    });
}

/**
 * Authorization-code + PKCE over a 127.0.0.1 loopback redirect (RFC 8252): bind
 * a loopback server, open the browser to the authorize URL, and exchange the
 * returned code for tokens. Manages its own spinner; throws on failure.
 */
async function authorizeViaLoopback(p: {
  server: string;
  fmt: OutputFormat;
  /** Force the AS sign-in page (account switch) via `prompt=login`. */
  forceSwitch: boolean;
}): Promise<OAuthTokens> {
  const pkce = await generatePkce();
  const state = generateState();
  const spin = p.fmt === "text" ? clack.spinner() : null;
  try {
    const callbackUrl = await runLoopbackAuth({
      authorizeUrl: (redirectUri) =>
        buildAuthorizeUrl({
          server: p.server,
          redirectUri,
          codeChallenge: pkce.challenge,
          state,
          // Force the AS sign-in page so the user can pick a different
          // account/provider instead of the silently-reused session.
          ...(p.forceSwitch ? { prompt: "login" } : {}),
        }),
      openBrowser,
      // The web UI is served at the server origin; link the user there from the
      // success page (their browser already has a session cookie there).
      uiUrl: p.server,
      onAuthorizeUrl: (url) => {
        if (p.fmt === "text") {
          clack.note(
            url,
            "Opening your browser to sign in. If it doesn't open, visit:",
          );
          spin?.start("Waiting for authorization...");
        }
      },
    });
    // Exchange the auth code for tokens (openid-client checks state + iss).
    const tokens = await exchangeCode({
      server: p.server,
      callbackUrl,
      codeVerifier: pkce.verifier,
      expectedState: state,
    });
    spin?.stop("Authorized!");
    return tokens;
  } catch (error) {
    spin?.stop("Authorization failed.");
    throw error;
  }
}

/**
 * Device Authorization Grant (RFC 8628) — the headless path. Request a device +
 * user code, show the verification URL + code (and open a browser unless
 * suppressed), then poll until the user approves. Manages its own spinner;
 * throws on denial / expiry / timeout.
 */
async function authorizeViaDevice(p: {
  server: string;
  fmt: OutputFormat;
  openBrowser: boolean;
}): Promise<OAuthTokens> {
  const auth = await startDeviceAuthorization({ server: p.server });
  const openUrl = auth.verificationUriComplete ?? auth.verificationUri;

  if (p.fmt === "text") {
    clack.note(
      `${auth.verificationUri}\n\nCode: ${auth.userCode}`,
      "To sign in, open this URL on any device and enter the code:",
    );
    // Best-effort convenience open (harmless if there's no browser here).
    if (p.openBrowser) await openBrowser(openUrl);
  } else {
    // Structured modes: emit the verification details on stderr so automation
    // can surface them, while stdout stays reserved for the final result object.
    process.stderr.write(
      `${JSON.stringify({
        verification_uri: auth.verificationUri,
        verification_uri_complete: auth.verificationUriComplete,
        user_code: auth.userCode,
        expires_in: auth.expiresIn,
      })}\n`,
    );
  }

  const spin = p.fmt === "text" ? clack.spinner() : null;
  spin?.start("Waiting for you to approve in the browser...");
  try {
    const tokens = await pollDeviceToken({
      server: p.server,
      deviceCode: auth.deviceCode,
      interval: auth.interval,
      expiresIn: auth.expiresIn,
    });
    spin?.stop("Authorized!");
    return tokens;
  } catch (error) {
    spin?.stop("Authorization failed.");
    throw error;
  }
}

/** Print an error per output mode and exit. Never returns. */
function fail(error: unknown, fmt: OutputFormat, server: string): never {
  const msg =
    error instanceof OAuthError ||
    error instanceof LoopbackError ||
    error instanceof RpcError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  if (fmt === "text") {
    clack.log.error(msg);
    clack.outro("Login failed.");
  } else {
    output({ error: msg, server }, fmt, () => {});
  }
  process.exit(1);
}

/**
 * Resolve and persist the active space after login. Returns the selected space,
 * or null when none could be selected (and leaves the active space unchanged).
 */
async function selectSpace(
  server: string,
  spaces: MemberSpaceResponse[],
  spaceArg: string | undefined,
  fmt: OutputFormat,
): Promise<MemberSpaceResponse | null> {
  // Explicit argument wins.
  if (spaceArg) {
    const match = matchSpace(spaces, spaceArg);
    if (!match) {
      const msg = `No space matching '${spaceArg}'.`;
      if (fmt === "text") {
        clack.log.error(msg);
        for (const s of spaces) console.log(`  ${s.name} (${s.slug})`);
      }
      // Don't abort the whole login — the session is already stored.
      return null;
    }
    setActiveSpace(server, match.slug);
    return match;
  }

  // Exactly one space → auto-select.
  if (spaces.length === 1 && spaces[0]) {
    setActiveSpace(server, spaces[0].slug);
    return spaces[0];
  }

  // Multiple spaces in an interactive session → prompt.
  if (spaces.length > 1 && fmt === "text") {
    const choice = await clack.select({
      message: "Select the active space",
      options: spaces.map((s) => ({
        value: s.slug,
        label: `${s.name} (${s.slug})`,
      })),
    });
    if (clack.isCancel(choice)) return null;
    setActiveSpace(server, choice as string);
    return spaces.find((s) => s.slug === choice) ?? null;
  }

  return null;
}

type LoginUserClient = ReturnType<typeof createUserClient>;

/**
 * Pending invitations addressed to the logged-in email. Best-effort: an error
 * (e.g. an unverified email) yields an empty list rather than failing login.
 */
async function fetchPendingInvites(
  user: LoginUserClient,
): Promise<PendingInvitationResponse[]> {
  try {
    const { invitations } = await user.invite.pending();
    return invitations;
  } catch {
    return [];
  }
}

/**
 * Let the user pick which pending invitations to accept (a multiselect; none is
 * a valid choice). Unselected invitations are left pending — declining stays an
 * explicit `me invite decline`. Returns the set of accepted invitation ids.
 */
async function acceptInvitationsInteractive(
  user: LoginUserClient,
  invites: PendingInvitationResponse[],
): Promise<Set<string>> {
  const accepted = new Set<string>();
  const choice = await clack.multiselect({
    message: "You've been invited to these spaces. Accept any now?",
    required: false,
    options: invites.map((i) => {
      const bits = [
        i.admin ? "admin" : null,
        i.groupNames.length ? `groups:${i.groupNames.join(", ")}` : null,
      ].filter(Boolean);
      return {
        value: i.invitationId,
        label: `${i.spaceName} (${i.spaceSlug})`,
        hint: bits.length > 0 ? bits.join(", ") : undefined,
      };
    }),
  });
  if (clack.isCancel(choice)) return accepted;
  for (const id of choice as string[]) {
    try {
      await user.invite.accept({ invitationId: id });
      accepted.add(id);
    } catch (err) {
      clack.log.warn(
        `Could not accept one invitation: ${(err as Error).message}`,
      );
    }
  }
  if (accepted.size > 0) {
    clack.log.success(`Accepted ${accepted.size} invitation(s).`);
  }
  return accepted;
}

/**
 * Offer to provision a personal "default" space when the user has none — but
 * only interactively. A non-interactive / JSON login leaves the user space-less
 * (they can `me space create` or accept an invitation later), so scripts and a
 * not-yet-redeemed magic-link flow are never surprised by a junk space.
 */
async function maybeCreateDefaultSpace(
  user: LoginUserClient,
  interactive: boolean,
): Promise<MemberSpaceResponse | null> {
  if (!interactive) return null;
  const yes = await clack.confirm({
    message: "You have no spaces yet. Create a personal space now?",
  });
  if (clack.isCancel(yes) || !yes) {
    clack.log.info(
      "You can create one later with 'me space create', or join one with 'me invite accept'.",
    );
    return null;
  }
  const { created, space } = await user.space.ensureDefault();
  return created ? space : null;
}
