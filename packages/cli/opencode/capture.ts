/** OpenCode capture hook types and profile-aware credential resolution. */
import type { ResolvedCredentials } from "../credentials.ts";
import { DEFAULT_SESSIONS_NODE_NAME } from "../importers/index.ts";
import type { CaptureSurface } from "../local-config.ts";

/** Per-project sessions leaf, shared with `me import opencode`. */
export const SESSIONS_NODE = DEFAULT_SESSIONS_NODE_NAME;

export const HOOK_EVENT_NAMES = ["idle", "deleted"] as const;
export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

export interface HookConfig {
  server: string;
  apiKey?: string;
  space: string;
  treeRoot: string;
  tree?: string;
  fullTranscript: boolean;
}

export type HookCreds = Pick<ResolvedCredentials, "apiKey" | "loggedIn">;

/** Return null when local credentials cannot authorize a selected profile. */
export function resolveHookConfig(
  creds: HookCreds,
  profile: CaptureSurface,
): HookConfig | null {
  if (!creds.apiKey && !creds.loggedIn) return null;
  if (!profile.server || !profile.space) return null;
  return {
    server: profile.server,
    apiKey: creds.apiKey,
    space: profile.space,
    treeRoot: profile.tree_root ?? "",
    tree: profile.tree,
    fullTranscript: false,
  };
}
