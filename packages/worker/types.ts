import type { EmbeddingConfig } from "@memory-engine/embedding";

export interface EngineTarget {
  schema: string;
  shard: number;
}

export interface WorkerConfig {
  embedding: EmbeddingConfig;
  /** Discover active engines (schema + shard) from accounts DB */
  discover: () => Promise<EngineTarget[]>;
  /** Number of queue entries to claim per batch (default: 10) */
  batchSize?: number;
  /** PostgreSQL interval for claim lock duration (default: '5 minutes') */
  lockDuration?: string;
  /** Delay between polls when no work was found (default: 10_000ms) */
  idleDelayMs?: number;
  /** Maximum backoff delay on consecutive errors (default: 60_000ms) */
  maxBackoffMs?: number;
  /** How often to re-discover engines (default: 60_000ms) */
  refreshIntervalMs?: number;
  /** Exit gracefully after this much idle time (optional) */
  drainTimeoutMs?: number;
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
  consecutiveErrors: number;
  lastError?: string;
}
