import type { Sql } from "postgres";
import type { WorkerConfig, WorkerStats } from "./types";
import { type RateLimitGate, Worker } from "./worker";

/**
 * Pool of N embedding workers using the provided SQL connection pool.
 * Each worker independently discovers spaces, shuffles its target list,
 * and polls queues. FOR UPDATE SKIP LOCKED prevents double-processing.
 */
export class WorkerPool {
  private readonly sql: Sql;
  private readonly config: WorkerConfig;
  private workers: Worker[] = [];
  private running = false;
  private stopRequested = false;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  /**
   * Shared rate-limit gate handed to every worker: a 429 on any one of them
   * stands the whole pool down for the backoff window.
   */
  private readonly gate: RateLimitGate = { until: 0 };

  constructor(sql: Sql, config: WorkerConfig) {
    this.sql = sql;
    this.config = config;
  }

  async start(count: number): Promise<void> {
    if (this.running) {
      throw new Error("Worker pool is already running");
    }

    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("Worker count must be a non-negative integer");
    }
    this.running = true;
    this.stopRequested = false;
    this.workers = [];
    this.startPromise = (async () => {
      try {
        for (let i = 0; i < count && !this.stopRequested; i++) {
          const worker = new Worker(this.sql, this.config, this.gate);
          this.workers.push(worker);
          await worker.start();
        }
      } catch (error) {
        // Do not call stop(): it waits for this startup promise. Roll back
        // directly so a concurrent external stop cannot deadlock startup.
        await Promise.allSettled(this.workers.map((worker) => worker.stop()));
        throw error;
      }
    })();
    try {
      await this.startPromise;
    } catch (error) {
      if (!this.stopPromise) {
        this.running = false;
        this.startPromise = null;
      }
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.running) return Promise.resolve();
    this.stopRequested = true;
    // Abort partial startup immediately, not after discovery has completed.
    const draining = Promise.allSettled(this.workers.map((w) => w.stop()));
    this.stopPromise = (async () => {
      try {
        await this.startPromise?.catch(() => {});
        const results = await draining;
        const failed = results.find((r) => r.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      } finally {
        this.running = false;
        this.startPromise = null;
        this.stopPromise = null;
      }
    })();
    return this.stopPromise;
  }

  /** Rejects on a fatal loop failure, resolves after all loops drain. */
  get finished(): Promise<void> {
    return Promise.all(this.workers.map((worker) => worker.finished)).then(
      () => {},
    );
  }

  get stats(): WorkerStats {
    const agg: WorkerStats = {
      schemasPolled: 0,
      totalProcessed: 0,
      totalFailed: 0,
      totalPruned: 0,
      spacesDropped: 0,
      consecutiveErrors: 0,
    };
    for (const worker of this.workers) {
      const s = worker.stats;
      agg.schemasPolled += s.schemasPolled;
      agg.totalProcessed += s.totalProcessed;
      agg.totalFailed += s.totalFailed;
      agg.totalPruned += s.totalPruned;
      agg.spacesDropped += s.spacesDropped;
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
