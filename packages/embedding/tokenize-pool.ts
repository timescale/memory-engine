import { Buffer } from "node:buffer";
import { availableParallelism } from "node:os";
import { Worker as ThreadWorker } from "node:worker_threads";
import { type TruncateResult, truncateToTokenLimit } from "./truncate";

interface TruncateRequest {
  id: number;
  maxTokens: number;
  texts: string[];
}

interface TruncateResponse {
  id: number;
  results?: TruncateResult[];
  error?: string;
}

interface PendingJob {
  inputBytes: number;
  id: number;
  maxTokens: number;
  texts: string[];
  resolve: (results: TruncateResult[]) => void;
  reject: (error: Error) => void;
}

interface TokenizeWorker {
  worker: ThreadWorker;
  current: PendingJob | undefined;
}

function truncateInline(texts: string[], maxTokens: number): TruncateResult[] {
  return texts.map((text) => truncateToTokenLimit(text, maxTokens));
}

function parseThreadCount(): number {
  const raw = process.env.EMBEDDING_TOKENIZE_THREADS;
  if (raw !== undefined && raw !== "") {
    // Strict: only a bare non-negative integer. Number.parseInt would silently
    // accept "1.5" (→1) or "2abc" (→2) and misconfigure the pool, so reject
    // anything that isn't all digits before parsing.
    if (!/^\d+$/.test(raw.trim())) {
      throw new Error(
        "EMBEDDING_TOKENIZE_THREADS must be a non-negative integer",
      );
    }
    return Number.parseInt(raw, 10);
  }

  // Auto-size: leave a core free for the main thread (cores - 1) and cap at 4
  // workers by default — tokenization is a latency mitigation, not a throughput
  // sink, so more than 4 threads buys little. Floor of 1 for single-core hosts.
  const cores = availableParallelism();
  return Math.max(1, Math.min(cores - 1, 4));
}

export interface TokenizerPoolStats {
  threads: number;
  activeJobs: number;
  queuedJobs: number;
  activeInputBytes: number;
  queuedInputBytes: number;
}

class TokenizePool {
  private readonly workers: TokenizeWorker[] = [];
  private readonly queue: PendingJob[] = [];
  private nextId = 1;
  private closed = false;
  private activeJobs = 0;
  private activeInputBytes = 0;
  private queuedInputBytes = 0;

  constructor(size: number) {
    // Spawn every worker eagerly rather than lazily on demand. The pool itself
    // is already lazy (built on the first truncate call), but once it exists we
    // want all workers prewarmed: each thread's startup pays a cold start —
    // spawn + import of the cl100k_base BPE tokenizer data (tens of ms). Loading
    // them all up front means workers 1..N warm concurrently while worker 0
    // handles the first job, so a concurrent burst (batch embed / search) finds
    // every worker hot instead of eating that cold start on the request path —
    // exactly the latency this pool exists to remove.
    try {
      for (let i = 0; i < size; i++) {
        this.workers.push(this.createWorker());
      }
    } catch (error) {
      // Do not leak already-created threads if a later spawn fails.
      void this.shutdown();
      throw error;
    }
  }

  stats(): TokenizerPoolStats {
    return {
      threads: this.workers.length,
      activeJobs: this.activeJobs,
      queuedJobs: this.queue.length,
      activeInputBytes: this.activeInputBytes,
      queuedInputBytes: this.queuedInputBytes,
    };
  }

  private clearCurrent(entry: TokenizeWorker): PendingJob | undefined {
    const job = entry.current;
    if (job) {
      entry.current = undefined;
      this.activeJobs--;
      this.activeInputBytes -= job.inputBytes;
    }
    return job;
  }

  truncateMany(texts: string[], maxTokens: number): Promise<TruncateResult[]> {
    if (this.closed) {
      return Promise.reject(new Error("Tokenizer pool is shut down"));
    }

    if (texts.length === 0) {
      return Promise.resolve([]);
    }

    // byteLength measures UTF-8 without allocating a second copy of the input.
    const inputBytes = texts.reduce(
      (total, text) => total + Buffer.byteLength(text, "utf8"),
      0,
    );
    return new Promise((resolve, reject) => {
      this.queuedInputBytes += inputBytes;
      this.queue.push({
        inputBytes,
        id: this.nextId++,
        maxTokens,
        texts,
        resolve,
        reject,
      });
      this.dispatch();
    });
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    while (this.queue.length > 0) {
      this.queue.shift()?.reject(new Error("Tokenizer pool shut down"));
    }

    this.queuedInputBytes = 0;
    const terminations = this.workers.map(async (entry) => {
      this.clearCurrent(entry)?.reject(new Error("Tokenizer pool shut down"));
      await entry.worker.terminate();
    });
    this.workers.length = 0;
    await Promise.allSettled(terminations);
  }

  private createWorker(): TokenizeWorker {
    const worker = new ThreadWorker(
      new URL("./tokenize.worker.ts", import.meta.url),
    );
    worker.unref?.();

    const entry: TokenizeWorker = { worker, current: undefined };

    worker.on("message", (message: TruncateResponse) => {
      const job = entry.current;
      if (!job || message.id !== job.id) {
        return;
      }

      this.clearCurrent(entry);
      if (message.error) {
        job.reject(new Error(message.error));
      } else if (
        !message.results ||
        message.results.length !== job.texts.length
      ) {
        // Protocol invariant broken (missing or misaligned results). Reject so
        // truncateTextsToTokenLimit falls back to inline rather than throwing
        // (single path) or producing misaligned batch results.
        job.reject(
          new Error(
            `Tokenizer worker returned ${
              message.results?.length ?? 0
            } result(s) for ${job.texts.length} text(s)`,
          ),
        );
      } else {
        job.resolve(message.results);
      }
      this.dispatch();
    });

    worker.on("error", (error) => {
      this.replaceFailedWorker(
        entry,
        error instanceof Error ? error : new Error(String(error)),
      );
    });

    worker.on("exit", (code) => {
      if (this.closed) {
        return;
      }
      this.replaceFailedWorker(
        entry,
        new Error(`Tokenizer worker exited with code ${code}`),
      );
    });

    return entry;
  }

  private replaceFailedWorker(entry: TokenizeWorker, error: Error): void {
    const index = this.workers.indexOf(entry);
    this.clearCurrent(entry)?.reject(error);

    if (index !== -1) {
      // Best-effort terminate the failed worker before replacing it so a thread
      // stuck in a bad state doesn't leak. A resulting exit event is a no-op:
      // the entry is no longer in this.workers.
      this.workers.splice(index, 1);
      void entry.worker.terminate().catch(() => {});

      if (!this.closed) {
        try {
          this.workers.splice(index, 0, this.createWorker());
        } catch {
          // Remaining workers may still serve the queue. If none survive,
          // reject queued jobs so callers fall back inline rather than hang.
          if (this.workers.length === 0) {
            if (pool === this) pool = undefined;
            void this.shutdown();
          }
        }
      }
    }

    this.dispatch();
  }

  private dispatch(): void {
    if (this.closed) {
      return;
    }

    for (const entry of this.workers) {
      if (this.queue.length === 0) {
        return;
      }
      if (entry.current) {
        continue;
      }

      const job = this.queue.shift();
      if (!job) {
        return;
      }

      this.queuedInputBytes -= job.inputBytes;
      this.activeInputBytes += job.inputBytes;
      this.activeJobs++;
      entry.current = job;
      const request: TruncateRequest = {
        id: job.id,
        maxTokens: job.maxTokens,
        texts: job.texts,
      };
      try {
        entry.worker.postMessage(request);
      } catch (error) {
        // The worker died between selection and send. Reject this job and
        // replace the slot instead of leaving entry.current stuck.
        this.replaceFailedWorker(
          entry,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }
}

let pool: TokenizePool | undefined;

/** Constant-time snapshot; never creates the lazy pool or retains input texts. */
export function getTokenizerPoolStats(): TokenizerPoolStats {
  return (
    pool?.stats() ?? {
      threads: 0,
      activeJobs: 0,
      queuedJobs: 0,
      activeInputBytes: 0,
      queuedInputBytes: 0,
    }
  );
}

export function getTokenizerThreadCount(): number {
  return parseThreadCount();
}

export async function truncateTextsToTokenLimit(
  texts: string[],
  maxTokens: number,
): Promise<TruncateResult[]> {
  const threadCount = parseThreadCount();
  if (threadCount === 0) {
    return truncateInline(texts, maxTokens);
  }

  try {
    pool ??= new TokenizePool(threadCount);
    return await pool.truncateMany(texts, maxTokens);
  } catch {
    return truncateInline(texts, maxTokens);
  }
}

export async function shutdownTokenizerPool(): Promise<void> {
  const existing = pool;
  pool = undefined;
  await existing?.shutdown();
}
