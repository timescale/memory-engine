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
import {
  createAccountsClient,
  createAuthClient,
  DeviceFlowError,
} from "@memory-engine/client";
import type { OAuthProvider } from "@memory-engine/protocol/auth/device-flow";
import { Command } from "commander";
import { resolveServer, storeSessionToken } from "../credentials.ts";
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

      const provider = await clack.select({
        message: "Choose an auth provider",
        options: [
          { value: "github", label: "GitHub" },
          { value: "google", label: "Google" },
        ],
      });

      if (clack.isCancel(provider)) {
        if (fmt === "text") clack.cancel("Login cancelled.");
        process.exit(0);
      }

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

        output({ server, identity }, fmt, () => {
          clack.log.success(
            `Logged in as ${identity.name} (${identity.email})`,
          );
          clack.log.info(`Server: ${server}`);
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
