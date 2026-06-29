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
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        "EMBEDDING_TOKENIZE_THREADS must be a non-negative integer",
      );
    }
    return value;
  }

  const cores = availableParallelism();
  return Math.max(1, Math.min(cores - 1, 4));
}

class TokenizePool {
  private readonly workers: TokenizeWorker[] = [];
  private readonly queue: PendingJob[] = [];
  private nextId = 1;
  private closed = false;

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      this.workers.push(this.createWorker());
    }
  }

  truncateMany(texts: string[], maxTokens: number): Promise<TruncateResult[]> {
    if (this.closed) {
      return Promise.reject(new Error("Tokenizer pool is shut down"));
    }

    if (texts.length === 0) {
      return Promise.resolve([]);
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
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

    const terminations = this.workers.map(async (entry) => {
      entry.current?.reject(new Error("Tokenizer pool shut down"));
      entry.current = undefined;
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

      entry.current = undefined;
      if (message.error) {
        job.reject(new Error(message.error));
      } else {
        job.resolve(message.results ?? []);
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
      if (this.closed || code === 0) {
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
    const job = entry.current;
    entry.current = undefined;
    job?.reject(error);

    if (index !== -1) {
      if (this.closed) {
        this.workers.splice(index, 1);
      } else {
        this.workers[index] = this.createWorker();
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

      entry.current = job;
      const request: TruncateRequest = {
        id: job.id,
        maxTokens: job.maxTokens,
        texts: job.texts,
      };
      entry.worker.postMessage(request);
    }
  }
}

let pool: TokenizePool | undefined;

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
