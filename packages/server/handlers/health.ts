import { info } from "@pydantic/logfire-node";
import type { SQL } from "bun";
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
 * Verifies both database pools are alive via SELECT 1.
 * Returns 200 if both succeed, 503 if either fails.
 */
export function readyHandler(
  accountsSql: SQL,
  engineSql: SQL,
): (_request: Request) => Promise<Response> {
  return async (_request: Request) => {
    const checks: Record<string, string> = {};

    const [accountsResult, engineResult] = await Promise.allSettled([
      accountsSql`SELECT 1`,
      engineSql`SELECT 1`,
    ]);

    checks.accounts_db =
      accountsResult.status === "fulfilled"
        ? "ok"
        : `error: ${accountsResult.reason instanceof Error ? accountsResult.reason.message : String(accountsResult.reason)}`;

    checks.engine_db =
      engineResult.status === "fulfilled"
        ? "ok"
        : `error: ${engineResult.reason instanceof Error ? engineResult.reason.message : String(engineResult.reason)}`;

    const allOk = checks.accounts_db === "ok" && checks.engine_db === "ok";

    return json(
      {
        status: allOk ? "ok" : "unavailable",
        checks,
      },
      allOk ? 200 : 503,
    );
  };
}
