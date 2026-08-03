/** User-global OpenCode integration paths. */
import { homedir } from "node:os";
import { join } from "node:path";

export const openCodePluginsDir = (): string =>
  join(homedir(), ".config", "opencode", "plugins");
