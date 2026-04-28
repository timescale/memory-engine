import type { EmbeddingConfig } from "@memory.build/embedding";

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
   * Number of times an engine was dropped from the in-memory target list
   * because its schema no longer exists in PostgreSQL (e.g. engine deleted
   * between discover() refreshes). Self-heals on the next refresh.
   */
  enginesDropped: number;
  consecutiveErrors: number;
  lastError?: string;
}
