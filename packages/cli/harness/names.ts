export const HARNESS_NAMES = ["claude", "opencode", "codex", "gemini"] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];
