import type { SQL } from "bun";
import type { WorkerConfig, WorkerStats } from "./types";
import { Worker } from "./worker";

/**
 * Pool of N embedding workers sharing a single SQL connection pool.
 * Each worker independently discovers engines, shuffles its target list,
 * and polls queues. FOR UPDATE SKIP LOCKED prevents double-processing.
 */
export class WorkerPool {
  private readonly sql: SQL;
  private readonly config: WorkerConfig;
  private workers: Worker[] = [];
  private running = false;

  constructor(sql: SQL, config: WorkerConfig) {
    this.sql = sql;
    this.config = config;
  }

  async start(count: number): Promise<void> {
    if (this.running) {
      throw new Error("Worker pool is already running");
    }

    this.running = true;
    this.workers = [];
    for (let i = 0; i < count; i++) {
      const worker = new Worker(this.sql, this.config);
      this.workers.push(worker);
      await worker.start();
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    await Promise.all(this.workers.map((w) => w.stop()));
    this.running = false;
  }

  get stats(): WorkerStats {
    const agg: WorkerStats = {
      schemasPolled: 0,
      totalProcessed: 0,
      totalFailed: 0,
      consecutiveErrors: 0,
    };
    for (const worker of this.workers) {
      const s = worker.stats;
      agg.schemasPolled += s.schemasPolled;
      agg.totalProcessed += s.totalProcessed;
      agg.totalFailed += s.totalFailed;
      agg.consecutiveErrors = Math.max(
        agg.consecutiveErrors,
        s.consecutiveErrors,
      );
      if (s.lastError) agg.lastError = s.lastError;
    }
    return agg;
  }

  get size(): number {
    return this.workers.length;
  }
}
