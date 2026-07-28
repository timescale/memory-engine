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
