/**
 * HTTP header names shared between the server and clients.
 */

/**
 * Header the client uses to advertise its CLIENT_VERSION on every RPC.
 *
 * The server short-circuits requests with an incompatible client version
 * before dispatching them to a handler.
 */
export const CLIENT_VERSION_HEADER = "X-Client-Version";

/**
 * Header the client sends to select which space a memory-endpoint request
 * targets (both session and api-key auth). The value is the active space slug.
 */
export const SPACE_HEADER = "X-Me-Space";

/**
 * Header a *human*-authenticated memory-endpoint request sends to act as one of
 * the caller's own agents: the request authenticates as the human but is
 * authorized as the named agent (grants clamped to the human). The value is an
 * agent id or name, resolved server-side against the caller's owned agents.
 *
 * Ignored when the bearer is itself an agent api key (the key already *is* the
 * agent). Analogous to {@link SPACE_HEADER}; set by `--agent` / `ME_AGENT`.
 */
export const AGENT_HEADER = "X-Me-Agent";
