import { error, info } from "@pydantic/logfire-node";
import type { Sql } from "postgres";
import { json, text } from "../util/response";

/**
 * Liveness check handler.
 * Returns 200 "ok" for load balancer and monitoring.
 * No database check — fast and cheap.
 */
export function healthHandler(_request: Request): Response {
  info("Health check");
  return text("ok");
}

/**
 * Readiness check handler.
 * Verifies the database pool is alive via SELECT 1.
 * Returns 200 on success, 503 on failure.
 */
export function readyHandler(
  db: Sql,
): (_request: Request) => Promise<Response> {
  return async (_request: Request) => {
    const checks: Record<string, string> = {};

    const [dbResult] = await Promise.allSettled([db`SELECT 1`]);

    checks.db =
      dbResult.status === "fulfilled"
        ? "ok"
        : `error: ${dbResult.reason instanceof Error ? dbResult.reason.message : String(dbResult.reason)}`;

    const allOk = checks.db === "ok";

    if (!allOk) {
      // Emit an error-level record so the "Database in trouble" alert can key
      // off `message = 'Readiness check failed'` precisely, independent of the
      // `/health` heartbeat (which never touches the DB). Error level (not
      // warning) clears the alert's `level >= 'error'` gate. This is a log,
      // not an exception, so it stays out of the "Elevated internal errors"
      // signal.
      error("Readiness check failed", { db: checks.db });
    }

    return json(
      {
        status: allOk ? "ok" : "unavailable",
        checks,
      },
      allOk ? 200 : 503,
    );
  };
}
