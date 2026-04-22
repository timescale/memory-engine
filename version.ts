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
 */
import rootPkg from "./package.json";
import serverPkg from "./packages/server/package.json";

export const CLIENT_VERSION: string = rootPkg.version;
export const SERVER_VERSION: string = serverPkg.version;
