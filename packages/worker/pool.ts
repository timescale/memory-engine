import type { SQL } from "bun";
import type { WorkerConfig, WorkerStats } from "./types";
import { runDaemon } from "./worker";

export class WorkerPool {
  private readonly sql: SQL;
  private readonly config: WorkerConfig;
  private abort: AbortController | null = null;
  private daemonPromise: Promise<void> | null = null;
  private _stats: WorkerStats = {
    schemasPolled: 0,
    totalProcessed: 0,
    totalFailed: 0,
    consecutiveErrors: 0,
  };

  constructor(sql: SQL, config: WorkerConfig) {
    this.sql = sql;
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.abort) {
      throw new Error("Worker pool is already running");
    }

    this.abort = new AbortController();
    this.daemonPromise = runDaemon(this.sql, this.config, {
      signal: this.abort.signal,
    });
  }

  async stop(): Promise<void> {
    if (!this.abort) return;

    this.abort.abort();
    await this.daemonPromise;
    this.abort = null;
    this.daemonPromise = null;
  }

  /** Wake from idle sleep (for future LISTEN/NOTIFY) */
  poke(): void {
    // Future: interrupt idle sleep via a shared flag or secondary signal
  }

  get stats(): WorkerStats {
    return { ...this._stats };
  }
}
