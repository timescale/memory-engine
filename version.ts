/**
 * Single source of truth for the application version.
 *
 * Read from the root package.json. Used by:
 * - Server: telemetry serviceVersion, appVersion for migrations
 * - CLI: --version output
 * - MCP: server version in protocol handshake
 * - Database migrations: version table tracking
 */
import pkg from "./package.json";

export const APP_VERSION: string = pkg.version;
