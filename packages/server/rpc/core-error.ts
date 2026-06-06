/**
 * Map core control-plane SQL constraint violations to AppErrors, shared by the
 * space management and user RPC handlers.
 */
import { AppError } from "./errors";

/**
 * Unique → CONFLICT (e.g. duplicate name); the last-admin guard (ME001) →
 * LAST_ADMIN; foreign-key / check / bad-input → VALIDATION_ERROR; everything
 * else propagates.
 */
function mapCoreError(e: unknown): never {
  const code = (e as { code?: string }).code;
  if (code === "23505") {
    throw new AppError("CONFLICT", "A record with that name already exists");
  }
  if (code === "ME001") {
    throw new AppError(
      "LAST_ADMIN",
      "This would leave the space without an admin — promote another principal to admin first.",
    );
  }
  if (code === "23503" || code === "23514" || code === "22P02") {
    throw new AppError(
      "VALIDATION_ERROR",
      e instanceof Error ? e.message : "Invalid parameter",
    );
  }
  throw e instanceof Error ? e : new Error(String(e));
}

/** Run a coreStore call, mapping constraint violations to AppErrors. */
export async function guardCore<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    return mapCoreError(e);
  }
}
