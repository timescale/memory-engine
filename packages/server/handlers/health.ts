import { info } from "@pydantic/logfire-node";
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

    return json(
      {
        status: allOk ? "ok" : "unavailable",
        checks,
      },
      allOk ? 200 : 503,
    );
  };
}
