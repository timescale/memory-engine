import { error } from "@pydantic/logfire-node";
import type { Sql } from "postgres";
import { json, text } from "../util/response";

/**
 * Liveness check handler.
 * Returns 200 "ok" for load balancer and monitoring.
 * No database check — fast and cheap.
 */
export function healthHandler(_request: Request): Response {
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

    // The endpoint is unauthenticated, so the response carries only a
    // constant; the driver's error text (which can name hosts, databases,
    // users, or pool state) goes to the log.
    checks.db = dbResult.status === "fulfilled" ? "ok" : "error";

    const allOk = checks.db === "ok";

    if (!allOk) {
      // Emit an error-level record so the "Database in trouble" alert can key
      // off `message = 'Readiness check failed'` precisely, independent of the
      // `/health` heartbeat (which never touches the DB). Error level (not
      // warning) clears the alert's `level >= 'error'` gate. This is a log,
      // not an exception, so it stays out of the "Elevated internal errors"
      // signal.
      const reason =
        dbResult.status === "rejected"
          ? dbResult.reason instanceof Error
            ? dbResult.reason.message
            : String(dbResult.reason)
          : "unknown";
      error("Readiness check failed", { db: `error: ${reason}` });
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
