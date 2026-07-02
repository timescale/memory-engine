export const AS_AGENT_PROJECT_SENTINEL = ".me";

/** `.me` is a CLI-only sentinel and must never be sent as X-Me-As-Agent. */
export function assertConcreteAsAgent(asAgent: string | undefined): void {
  if (asAgent === AS_AGENT_PROJECT_SENTINEL) {
    throw new Error("asAgent '.me' must be resolved before creating a client");
  }
}
