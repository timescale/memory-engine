/** Claude Code hook event definitions. Runtime policy lives in local-config. */
import { DEFAULT_SESSIONS_NODE_NAME } from "../importers/index.ts";

/** Per-project sessions leaf, shared with `me import claude`. */
export const SESSIONS_NODE = DEFAULT_SESSIONS_NODE_NAME;

/** Capture hook events registered by the dormant Claude plugin. */
export const HOOK_EVENT_NAMES = ["stop", "session-end"] as const;
export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/** The portion of a Claude Code hook event consumed by our handlers. */
export interface HookEvent {
  cwd?: string;
  transcript_path?: string;
}
