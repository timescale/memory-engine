import { AppError } from "./errors";

/** Map PostgreSQL timeout SQLSTATEs to stable application-level RPC errors. */
export function mapDbTimeoutError(error: unknown): AppError | null {
  const code = (error as { code?: string }).code;
  if (code === "57014") {
    return new AppError("QUERY_TIMEOUT", "Database statement timed out");
  }
  if (code === "55P03") {
    return new AppError("LOCK_TIMEOUT", "Database lock wait timed out");
  }
  if (code === "25P04") {
    return new AppError(
      "TRANSACTION_TIMEOUT",
      "Database transaction timed out",
    );
  }
  return null;
}
