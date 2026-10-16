import { describe, expect, test } from "bun:test";
import { WorkerPool } from "./pool";
import type { WorkerConfig } from "./types";
import { Worker } from "./worker";

const config: WorkerConfig = {
  embedding: { provider: "openai", model: "test", dimensions: 3 },
  discover: async () => [],
  idleDelayMs: 1,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("worker lifecycle", () => {
  test("stop during discovery waits, prevents claims, and permits restart", async () => {
    const discovery = deferred<{ schema: string }[]>();
    let claims = 0;
    const worker = new Worker(
      {
        begin: async () => {
          claims++;
          return [];
        },
      } as never,
      {
        ...config,
        discover: () => discovery.promise,
      },
    );
    const starting = worker.start();
    const stopping = worker.stop();
    expect(worker.stop()).toBe(stopping);
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    await expect(worker.start()).rejects.toThrow("already running");
    discovery.resolve([{ schema: "me_test" }]);
    await Promise.all([starting, stopping]);
    expect(claims).toBe(0);
    await worker.stop();
    // Reuse with the same resolved discovery, but abort before its continuation.
    const restarting = worker.start();
    await worker.stop();
    await restarting;
    expect(claims).toBe(0);
  });

  for (const failDiscovery of [false, true]) {
    test(`pool stop during partial startup drains without later workers (failure=${failDiscovery})`, async () => {
      const discovery = deferred<{ schema: string }[]>();
      let discoveries = 0;
      let claims = 0;
      const pool = new WorkerPool(
        {
          begin: async () => {
            claims++;
            return [];
          },
        } as never,
        {
          ...config,
          discover: () => {
            discoveries++;
            return discovery.promise;
          },
        },
      );
      const starting = pool.start(3);
      // Attach rejection observation before releasing failed discovery.
      const started = starting.then(
        () => undefined,
        (error: Error) => error,
      );
      const stopping = pool.stop();
      expect(pool.stop()).toBe(stopping);
      let stopped = false;
      void stopping.then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      if (failDiscovery) discovery.reject(new Error("discovery interrupted"));
      else discovery.resolve([{ schema: "me_test" }]);
      const result = await started;
      await stopping;
      expect(failDiscovery ? result?.message : result).toBe(
        failDiscovery ? "discovery interrupted" : undefined,
      );
      expect(discoveries).toBe(1);
      expect(pool.size).toBe(1);
      expect(claims).toBe(0);
      await pool.stop();
      await pool.start(0);
      await pool.stop();
    });
  }

  test("initial discovery failure rejects start and allows retry", async () => {
    let fails = true;
    const worker = new Worker({} as never, {
      ...config,
      discover: async () => {
        if (fails) throw new Error("discovery unavailable");
        return [];
      },
    });
    await expect(worker.start()).rejects.toThrow("discovery unavailable");
    await worker.stop();
    fails = false;
    await worker.start();
    await worker.stop();
  });
  test("rediscovery failure is observable and stop still resets lifecycle", async () => {
    let calls = 0;
    const worker = new Worker({} as never, {
      ...config,
      refreshIntervalMs: 0,
      discover: async () => {
        if (++calls > 1) throw new Error("refresh failed");
        return [];
      },
    });
    await worker.start();
    await expect(worker.finished).rejects.toThrow("refresh failed");
    await expect(worker.stop()).rejects.toThrow("refresh failed");
    await worker.stop();
  });
  test("partial pool startup failure drains already-started loops", async () => {
    let calls = 0;
    const pool = new WorkerPool({} as never, {
      ...config,
      discover: async () => {
        if (++calls === 2) throw new Error("second discovery failed");
        return [];
      },
    });
    await expect(pool.start(2)).rejects.toThrow("second discovery failed");
    await pool.stop();
    await pool.start(1);
    await pool.stop();
  });
  test("zero-sized pools do not discover and invalid counts reject", async () => {
    const pool = new WorkerPool({} as never, {
      ...config,
      discover: async () => {
        throw new Error("must not discover");
      },
    });
    for (const count of [-1, 1.5, NaN, Infinity]) {
      await expect(pool.start(count)).rejects.toThrow("non-negative integer");
    }
    await pool.start(0);
    expect(pool.size).toBe(0);
    await pool.stop();
  });
  test("stop waits for in-flight queue transactions before completing", async () => {
    let release: (() => void) | undefined;
    let claimed: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sql = {
      begin: async () => {
        claimed?.();
        await pending;
        return [];
      },
    };
    const worker = new Worker(sql as never, {
      ...config,
      discover: async () => [{ schema: "me_test" }],
    });
    await worker.start();
    await entered;
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release?.();
    await stopping;
    expect(stopped).toBe(true);
  });
});
