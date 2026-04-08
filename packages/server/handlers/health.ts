import { info } from "@pydantic/logfire-node";
import { text } from "../util/response";

/**
 * Health check handler.
 * Returns 200 "ok" for load balancer and monitoring.
 */
export function healthHandler(_request: Request): Response {
  info("Health check");
  return text("ok");
}
