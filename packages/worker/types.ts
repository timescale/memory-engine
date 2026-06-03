import type { EmbeddingConfig } from "@memory.build/embedding";

/** A space schema (me_<slug>) the worker should process. */
export interface SpaceTarget {
  schema: string;
}

/** Transaction-local timeouts applied to each worker DB transaction. */
export interface WorkerTimeouts {
  statementTimeout: string;
  lockTimeout: string;
  transactionTimeout: string;
  idleInTransactionSessionTimeout: string;
}

export const DEFAULT_WORKER_TIMEOUTS: WorkerTimeouts = {
  statementTimeout: "25s",
  lockTimeout: "5s",
  transactionTimeout: "30s",
  idleInTransactionSessionTimeout: "30s",
};

export interface WorkerConfig {
  embedding: EmbeddingConfig;
  /** Discover the spaces (me_<slug> schemas) to process. */
  discover: () => Promise<SpaceTarget[]>;
  /** Number of queue entries to claim per batch (default: 10) */
  batchSize?: number;
  /** PostgreSQL interval for claim lock duration (default: '5 minutes') */
  lockDuration?: string;
  /** Delay between polls when no work was found (default: 10_000ms) */
  idleDelayMs?: number;
  /** Maximum backoff delay on consecutive errors (default: 60_000ms) */
  maxBackoffMs?: number;
  /** How often to re-discover spaces (default: 60_000ms) */
  refreshIntervalMs?: number;
  /** PostgreSQL transaction/session timeouts for worker DB work */
  timeouts?: WorkerTimeouts;
  /** Exit gracefully after this much idle time (optional) */
  drainTimeoutMs?: number;
  /**
   * PostgreSQL interval for retaining terminal-outcome queue rows
   * before they are pruned (default: '7 days').
   */
  pruneRetention?: string;
}

export interface ProcessResult {
  claimed: number;
  succeeded: number;
  failed: number;
}

export interface WorkerStats {
  schemasPolled: number;
  totalProcessed: number;
  totalFailed: number;
  totalPruned: number;
  /**
   * Number of times a space was dropped from the in-memory target list
   * because its schema no longer exists in PostgreSQL (e.g. space deleted
   * between discover() refreshes). Self-heals on the next refresh.
   */
  spacesDropped: number;
  consecutiveErrors: number;
  lastError?: string;
}
