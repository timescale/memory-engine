// packages/server/lib.ts
// Type exports for consumers who need to test or extend the server

export type { ServerContext } from "./context";
export { extractBearerToken } from "./middleware";
export { createRouter, type Router } from "./router";
