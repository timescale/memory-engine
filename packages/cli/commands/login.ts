/**
 * me login — authenticate via OAuth device flow.
 *
 * 1. User picks a provider (Google/GitHub)
 * 2. CLI starts device flow, gets user code + verification URL
 * 3. Opens browser (or tells user to visit URL manually)
 * 4. Polls until user completes auth
 * 5. Stores session token in credentials file
 * 6. Fetches and displays identity
 */
import * as clack from "@clack/prompts";
import type { OAuthProvider } from "@memory.build/protocol/auth/device-flow";
import { Command } from "commander";
import { CLIENT_VERSION, MIN_SERVER_VERSION } from "../../../version";
import {
  checkServerVersion,
  createAccountsClient,
  createAuthClient,
  DeviceFlowError,
  RpcError,
} from "../client.ts";
import {
  getEngineApiKey,
  resolveServer,
  storeApiKey,
  storeSessionToken,
} from "../credentials.ts";
import { getOutputFormat, output } from "../output.ts";

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

export function createLoginCommand(): Command {
  return new Command("login")
    .description("authenticate with Memory Engine via OAuth")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const server = resolveServer(globalOpts.server);
      const fmt = getOutputFormat(globalOpts);

      const auth = createAuthClient({ url: server });

      // --- Provider selection ---
      if (fmt === "text") {
        clack.intro("me login");
      }

      // --- Compatibility check ---
      // Verify that this CLI and the server agree on a compatible version
      // before sending the user through the OAuth round-trip. Failing here
      // is much friendlier than failing after they've authorized in their
      // browser.
      try {
        await checkServerVersion({
          url: server,
          clientVersion: CLIENT_VERSION,
          minServerVersion: MIN_SERVER_VERSION,
        });
      } catch (error) {
        const msg =
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

      // TODO: Re-enable Google OAuth once we have approved ToS/privacy policy
      const provider: OAuthProvider = "github";

      // --- Start device flow ---
      const spin = fmt === "text" ? clack.spinner() : null;
      spin?.start("Starting device flow...");

      let flow: Awaited<ReturnType<typeof auth.startDeviceFlow>>;
      try {
        flow = await auth.startDeviceFlow(provider as OAuthProvider);
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

      // --- Display code and open browser ---
      if (fmt === "text") {
        clack.note(
          `Code: ${flow.userCode}\nURL:  ${flow.verificationUri}`,
          "Enter this code in your browser",
        );
      }

      await openBrowser(flow.verificationUri);

      // --- Poll for token ---
      spin?.start("Waiting for authorization...");

      try {
        const result = await auth.pollForToken(flow.deviceCode, {
          interval: flow.interval,
          expiresIn: flow.expiresIn,
        });

        spin?.stop("Authorized!");

        // Store session token
        storeSessionToken(server, result.sessionToken);

        // Fetch identity via accounts client
        const accounts = createAccountsClient({
          url: server,
          sessionToken: result.sessionToken,
        });
        const identity = await accounts.me.get();

        // Auto-select engine if exactly one exists
        let engineInfo: {
          name: string;
          slug: string;
          orgName: string;
        } | null = null;
        let engineCount = 0;

        try {
          const { orgs } = await accounts.org.list();
          const allEngines: Array<{
            id: string;
            slug: string;
            name: string;
            orgName: string;
          }> = [];
          for (const org of orgs) {
            const { engines } = await accounts.engine.list({
              orgId: org.id,
            });
            for (const e of engines) {
              if (e.status === "active") {
                allEngines.push({
                  id: e.id,
                  slug: e.slug,
                  name: e.name,
                  orgName: org.name,
                });
              }
            }
          }
          engineCount = allEngines.length;

          if (allEngines.length === 1 && allEngines[0]) {
            const engine = allEngines[0];
            // Check if we already have a key for this engine
            const existingKey = getEngineApiKey(server, engine.slug);
            if (existingKey) {
              // Already have a key — just ensure it's active
              const { setActiveEngine } = await import("../credentials.ts");
              setActiveEngine(server, engine.slug);
              engineInfo = {
                name: engine.name,
                slug: engine.slug,
                orgName: engine.orgName,
              };
            } else {
              // Bootstrap access
              const setupResult = await accounts.engine.setupAccess({
                engineId: engine.id,
              });
              storeApiKey(server, setupResult.engineSlug, setupResult.rawKey);
              engineInfo = {
                name: setupResult.engineName,
                slug: setupResult.engineSlug,
                orgName: setupResult.orgName,
              };
            }
          }
        } catch {
          // Engine auto-select is best-effort — don't fail login
        }

        output({ server, identity, engine: engineInfo }, fmt, () => {
          clack.log.success(
            `Logged in as ${identity.name} (${identity.email})`,
          );
          clack.log.info(`Server: ${server}`);
          if (engineInfo) {
            clack.log.info(
              `Engine: ${engineInfo.name} (${engineInfo.orgName})`,
            );
          } else if (engineCount > 1) {
            clack.log.info(
              "Multiple engines found. Run 'me engine use' to select one.",
            );
          }
          clack.outro("Done!");
        });
      } catch (error) {
        spin?.stop("Authorization failed.");
        const msg =
          error instanceof DeviceFlowError
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
