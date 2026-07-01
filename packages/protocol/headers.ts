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
 * Header a human-authenticated caller (session / OAuth token / user PAT) sends
 * to act as one of their own agents. The value is the agent's id or name; the
 * server resolves it against the caller's owned agents and, on a match,
 * authorizes the request as that agent — constrained exactly as the agent's own
 * api key would be. Honored on both RPC endpoints; ignored when the bearer is
 * itself an agent api key (the bearer already is an agent).
 */
export const AS_AGENT_HEADER = "X-Me-As-Agent";
