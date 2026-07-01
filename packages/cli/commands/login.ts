/**
 * me login [space] — authenticate via OAuth 2.1 (auth-code + PKCE + loopback),
 * then pick the active space.
 *
 * 1. Compatibility check (fail fast before the browser round-trip)
 * 2. Bind a 127.0.0.1 loopback redirect, open the browser to the authorize URL
 * 3. The browser redirects back with an auth code; exchange it (PKCE) for tokens
 * 4. Store the OAuth token set (access + refresh) for the server
 * 5. Fetch identity (whoami) and the caller's spaces
 * 6. Select the active space (the X-Me-Space the rest of the CLI is scoped to):
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
import { formatSpaceLabel } from "../identity.ts";
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  generateState,
  OAuthError,
} from "../oauth.ts";
import { LoopbackError, runLoopbackAuth } from "../oauth-loopback.ts";
import { getOutputFormat, type OutputFormat, output } from "../output.ts";

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

export function createLoginCommand(): Command {
  return new Command("login")
    .description("authenticate with Memory Engine and select the active space")
    .argument("[space]", "space to activate after login (slug or name)")
    .action(async (spaceArg: string | undefined, _opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const server = resolveServer(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);

      if (fmt === "text") {
        clack.intro("me login");
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

      // --- Authorization-code + PKCE over a loopback redirect ---
      const pkce = await generatePkce();
      const state = generateState();
      const spin = fmt === "text" ? clack.spinner() : null;

      try {
        const callbackUrl = await runLoopbackAuth({
          authorizeUrl: (redirectUri) =>
            buildAuthorizeUrl({
              server,
              redirectUri,
              codeChallenge: pkce.challenge,
              state,
            }),
          openBrowser,
          onAuthorizeUrl: (url) => {
            if (fmt === "text") {
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
          server,
          callbackUrl,
          codeVerifier: pkce.verifier,
          expectedState: state,
        });
        spin?.stop("Authorized!");

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
            if (active) {
              clack.log.info(`Space:  ${formatSpaceLabel(active)}`);
              clack.note(
                "Run 'me claude init' at the root of a software development\nproject to set up Claude Code memory for it.",
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
        spin?.stop("Authorization failed.");
        fail(error, fmt, server);
      }
    });
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

/** Display label for a stored share-access level (null → "none"). */
function shareLabel(level: 1 | 2 | 3 | null): string {
  if (level === null) return "none";
  return level === 1 ? "read" : level === 2 ? "write" : "owner";
}

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
        i.shareAccess ? `share:${shareLabel(i.shareAccess)}` : null,
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
