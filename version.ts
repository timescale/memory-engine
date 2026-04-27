/**
 * Dual source of truth for application versions.
 *
 * The client and server release independently, so they each carry their own
 * semver counter and their own tag prefix:
 *
 *   CLIENT_VERSION  - root package.json
 *                     Tagged `v<x.y.z>` by `./bun run release:client`.
 *                     Used by:
 *                       - CLI `--version` output
 *                       - MCP server handshake (runs inside the CLI process)
 *                       - npm publish of @memory.build/{cli,client,protocol}
 *
 *   SERVER_VERSION  - packages/server/package.json
 *                     Tagged `server/v<x.y.z>` by `./bun run release:server`.
 *                     Used by:
 *                       - Server telemetry (Logfire serviceVersion)
 *                       - gitRevision fallback for code-source linking in prod
 *                       - Database migration tracking (applied_at_version,
 *                         <schema>.version, downgrade-rejection guard)
 *
 * Compatibility bounds for the cross-version handshake:
 *
 *   MIN_CLIENT_VERSION  - oldest CLIENT_VERSION the current server will accept.
 *                         Enforced server-side via the `X-Client-Version` header
 *                         on every RPC and exposed via `GET /api/v1/version`.
 *                         Bump in lockstep with a server release that drops
 *                         backward compatibility.
 *
 *   MIN_SERVER_VERSION  - oldest SERVER_VERSION the current client will accept.
 *                         Checked client-side after fetching `GET /api/v1/version`.
 *                         Bump in lockstep with a client release that requires
 *                         a newer server.
 */
import rootPkg from "./package.json";
import serverPkg from "./packages/server/package.json";

export const CLIENT_VERSION: string = rootPkg.version;
export const SERVER_VERSION: string = serverPkg.version;

export const MIN_CLIENT_VERSION = "0.2.0";
export const MIN_SERVER_VERSION = "0.1.17";
