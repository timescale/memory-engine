/**
 * Periodic auth-table cleanup.
 *
 * better-auth and the OAuth provider own their tables (sessions, verifications,
 * oauth_access_token, oauth_refresh_token) but don't purge expired rows on their
 * own, so the server sweeps them on a cron. These are the schema's
 * `cleanup_expired_*` SQL functions (auth migrations) called directly — the same
 * connection (the postgres.js app pool) and functions the retired AuthStore cron
 * used, schema-qualified the same way (`sql(schema)`).
 */
import type { Sql } from "postgres";

export interface AuthCleanupCounts {
  sessions: number;
  verifications: number;
  /** Expired OAuth access + refresh tokens combined. */
  oauthTokens: number;
}

/** Reclaim expired auth rows; returns the per-category delete counts. */
export async function cleanupExpiredAuth(
  db: Sql,
  authSchema: string,
): Promise<AuthCleanupCounts> {
  const sch = db(authSchema); // quoted-identifier qualifier
  const [sessions] = await db`select ${sch}.cleanup_expired_sessions() as n`;
  const [verifications] =
    await db`select ${sch}.cleanup_expired_verifications() as n`;
  const [oauth] = await db`select ${sch}.cleanup_expired_oauth_tokens() as n`;
  return {
    sessions: Number(sessions?.n ?? 0),
    verifications: Number(verifications?.n ?? 0),
    oauthTokens: Number(oauth?.n ?? 0),
  };
}
