export const HARNESS_NAMES = ["claude", "opencode", "codex"] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];
