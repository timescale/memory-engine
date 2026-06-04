/**
 * me login [space] — authenticate via OAuth device flow, then pick the active space.
 *
 * 1. Compatibility check (fail fast before the browser round-trip)
 * 2. Start device flow, show user code + URL, open browser
 * 3. Poll until the user authorizes → session token
 * 4. Store the session token for the server
 * 5. Fetch identity (whoami) and the caller's spaces
 * 6. Select the active space (the X-Me-Space the rest of the CLI is scoped to):
 *      - a [space] argument (slug or name) is honored if it matches
 *      - otherwise auto-select when the user has exactly one space
 *      - multiple → prompt (text) / report (json); zero → suggest `me space create`
 */
import * as clack from "@clack/prompts";
import type { OAuthProvider } from "@memory.build/protocol/auth/device-flow";
import type { MemberSpaceResponse } from "@memory.build/protocol/user";
import { Command } from "commander";
import { CLIENT_VERSION, MIN_SERVER_VERSION } from "../../../version";
import {
  checkServerVersion,
  createAuthClient,
  createUserClient,
  DeviceFlowError,
  RpcError,
} from "../client.ts";
import {
  resolveServer,
  setActiveSpace,
  storeSessionToken,
} from "../credentials.ts";
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

      const auth = createAuthClient({ url: server });

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
        const msg = error instanceof Error ? error.message : String(error);
        if (fmt === "text") {
          clack.log.error(msg);
          clack.outro("Login failed.");
        } else {
          output({ error: msg, server }, fmt, () => {});
        }
        process.exit(1);
      }

      // TODO: Re-enable Google OAuth once we have approved ToS/privacy policy
      const provider: OAuthProvider = "github";

      // --- Start device flow ---
      const spin = fmt === "text" ? clack.spinner() : null;
      spin?.start("Starting device flow...");

      let flow: Awaited<ReturnType<typeof auth.startDeviceFlow>>;
      try {
        flow = await auth.startDeviceFlow(provider);
      } catch (error) {
        spin?.stop("Failed to start device flow.");
        const msg = error instanceof Error ? error.message : String(error);
        if (fmt === "text") {
          clack.log.error(msg);
          clack.outro("Login failed.");
        } else {
          output({ error: msg }, fmt, () => {});
        }
        process.exit(1);
      }

      spin?.stop("Device flow started.");

      if (fmt === "text") {
        clack.note(
          `Code: ${flow.userCode}\nURL:  ${flow.verificationUri}`,
          "Enter this code in your browser",
        );
      }
      await openBrowser(flow.verificationUri);

      // --- Poll for the session token ---
      spin?.start("Waiting for authorization...");

      try {
        const result = await auth.pollForToken(flow.deviceCode, {
          interval: flow.interval,
          expiresIn: flow.expiresIn,
        });
        spin?.stop("Authorized!");

        storeSessionToken(server, result.sessionToken);

        const user = createUserClient({
          url: server,
          token: result.sessionToken,
        });
        const identity = await user.whoami();
        const { spaces } = await user.space.list();

        const active = await selectSpace(server, spaces, spaceArg, fmt);

        output({ server, identity, space: active }, fmt, () => {
          clack.log.success(
            `Logged in as ${identity.name} (${identity.email})`,
          );
          clack.log.info(`Server: ${server}`);
          if (active) {
            clack.log.info(`Space:  ${active.name} (${active.slug})`);
          } else if (spaces.length === 0) {
            clack.log.info("No spaces yet. Run 'me space create <name>'.");
          } else {
            clack.log.info("Run 'me space use <space>' to select a space.");
          }
          clack.outro("Done!");
        });
      } catch (error) {
        spin?.stop("Authorization failed.");
        const msg =
          error instanceof DeviceFlowError || error instanceof RpcError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        if (fmt === "text") {
          clack.log.error(msg);
          clack.outro("Login failed.");
        } else {
          output({ error: msg }, fmt, () => {});
        }
        process.exit(1);
      }
    });
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
