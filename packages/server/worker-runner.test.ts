import { expect, test } from "bun:test";

async function runRunner(
  trigger: string,
  options: {
    entry?: "worker" | "index";
    delayedSignal?: boolean;
    startupFailure?: boolean;
    drainFailure?: boolean;
    telemetryFailure?: boolean;
  } = {},
) {
  // Real child process handlers/exits, without databases or telemetry exporters.
  const script = `
    import { mock } from "bun:test";
    let rejectLoop;
    const finished = new Promise((_, reject) => { rejectLoop = reject; });
    const stop = async () => {
      console.log("draining");
      await Bun.sleep(60);
      console.log("drained");
      ${options.drainFailure ? 'throw new Error("drain failed");' : ""}
    };
    const start = async () => {
      ${options.startupFailure ? 'console.log("startup cleanup"); throw new Error("startup failed");' : ""}
      ${options.delayedSignal ? 'setTimeout(() => process.kill(process.pid, "SIGTERM"), 5); await Bun.sleep(60); console.log("booted");' : ""}
      return { finished, workerFinished: finished, stop, url: "test" };
    };
    mock.module("@memory.build/database/telemetry", () => ({ reportError() {} }));
    mock.module("./packages/server/telemetry.ts", () => ({ configureTelemetry() {
      console.log("sampling");
      return { stop: async () => {
        console.log("telemetry flush");
        ${options.telemetryFailure ? 'throw new Error("flush failed");' : ""}
      } };
    } }));
    mock.module("@pydantic/logfire-node", () => ({ info(message) {
      if (message.includes("ready")) console.log("ready");
    } }));
    mock.module("./packages/server/worker-start.ts", () => ({ startEmbeddingWorkers: start }));
    mock.module("./packages/server/start.ts", () => ({ startServer: start }));
    await import("./packages/server/${options.entry ?? "worker"}.ts");
    ${trigger}
  `;
  const child = Bun.spawn(["./bun", "-e", script], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  // Do not leave a hung child behind if a lifecycle regression deadlocks.
  const timeout = setTimeout(() => child.kill("SIGKILL"), 4000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(
      stdout
        .trim()
        .split("\n")
        .slice(options.startupFailure ? -2 : -3),
    ).toEqual(
      options.startupFailure
        ? ["startup cleanup", "telemetry flush"]
        : ["draining", "drained", "telemetry flush"],
    );
    expect(stdout.match(/telemetry flush/g)?.length).toBe(1);
    expect(stdout.startsWith("sampling\n")).toBe(true);
    if (!options.startupFailure)
      expect(stdout.match(/drained/g)?.length).toBe(1);
    return { code, stdout };
  } finally {
    clearTimeout(timeout);
  }
}

test("startServer shares stop until HTTP, workers, tokenizer, and both pools drain", async () => {
  const child = Bun.spawn(
    [
      "./bun",
      "-e",
      `
    import { expect, mock } from "bun:test";
    let releaseWorker;
    let releaseTokenizer;
    const workerDrain = new Promise(resolve => { releaseWorker = resolve; });
    const tokenizerDrain = new Promise(resolve => { releaseTokenizer = resolve; });
    const events = [];
    let releaseRequest;
    let requestEntered;
    const requestGate = new Promise(resolve => { releaseRequest = resolve; });
    const entered = new Promise(resolve => { requestEntered = resolve; });
    mock.module("@memory.build/database", () => ({
      bootstrapSpaceDatabase() {}, migrateAuth() {}, migrateCore() {}, migrateSpace() {},
      slugToSchema: slug => slug
    }));
    mock.module("postgres", () => ({ default: () => ({ end: async () => { events.push("runtime"); } }) }));
    const embedding = await import("./packages/embedding/index.ts");
    mock.module("@memory.build/embedding", () => ({
      ...embedding,
      getTokenizerThreadCount: () => 0,
      shutdownTokenizerPool: async () => { events.push("tokenizer"); await tokenizerDrain; }
    }));
    mock.module("@memory.build/engine/core", () => ({ coreStore: () => ({}) }));
    mock.module("./packages/server/auth/betterauth.ts", () => ({ createBetterAuth: () => ({
      auth: {}, pool: { end: async () => { events.push("auth"); } }
    }) }));
    mock.module("./packages/server/router.ts", () => ({ createRouter: () => ({
      handleRequest: async () => {
        requestEntered();
        await requestGate;
        return new Response("ok");
      }
    }) }));
    mock.module("./packages/server/middleware/index.ts", () => ({ checkSizeLimit: () => null }));
    mock.module("./packages/server/worker-start.ts", () => ({ startWorkerPool: async () => ({
      finished: new Promise(() => {}), stop: async () => { events.push("workers"); await workerDrain; }
    }) }));
    const { startServer } = await import("./packages/server/start.ts");
    const server = await startServer({
      databaseUrl: "postgres://unused", apiBaseUrl: "http://localhost", betterAuthSecret: "test",
      port: 0, migrate: false, enableCleanupCron: false, workerCount: 1,
      embeddingConfig: { provider: "openai", model: "test", dimensions: 3 }
    });
    const request = fetch(server.url);
    await entered;
    const first = server.stop();
    const second = server.stop();
    expect(second).toBe(first);
    let stopped = false;
    void second.then(() => { stopped = true; });
    await Bun.sleep(5);
    expect(stopped).toBe(false);
    expect(events).toEqual([]);
    releaseRequest();
    expect(await (await request).text()).toBe("ok");
    await Bun.sleep(5);
    expect(stopped).toBe(false);
    expect(events).toEqual(["workers"]);
    releaseWorker();
    await Bun.sleep(5);
    expect(stopped).toBe(false);
    expect(events).toEqual(["workers", "tokenizer"]);
    releaseTokenizer();
    await Promise.all([first, second]);
    await server.stop();
    expect(events).toEqual(["workers", "tokenizer", "runtime", "auth"]);
    console.log("complete");
  `,
    ],
    {
      cwd: new URL("../..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timeout = setTimeout(() => child.kill("SIGKILL"), 4000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    expect(stdout.trim()).toBe("complete");
  } finally {
    clearTimeout(timeout);
  }
});

test("standalone SIGTERM awaits drain before exiting successfully", async () => {
  expect((await runRunner('process.kill(process.pid, "SIGTERM");')).code).toBe(
    0,
  );
});

test("standalone exits nonzero after fatal loop failure", async () => {
  expect(
    (await runRunner('rejectLoop(new Error("fatal refresh"));')).code,
  ).toBe(1);
});

for (const entry of ["worker", "index"] as const) {
  test(`${entry}: startup failure flushes after bootstrap cleanup`, async () => {
    expect((await runRunner("", { entry, startupFailure: true })).code).toBe(1);
  });

  test(`${entry}: drain failure still flushes and exits nonzero`, async () => {
    expect(
      (
        await runRunner('process.kill(process.pid, "SIGTERM");', {
          entry,
          drainFailure: true,
        })
      ).code,
    ).toBe(1);
  });

  test(`${entry}: telemetry failure cannot prevent successful signal exit`, async () => {
    expect(
      (
        await runRunner('process.kill(process.pid, "SIGTERM");', {
          entry,
          telemetryFailure: true,
        })
      ).code,
    ).toBe(0);
  });

  for (const trigger of [
    'void Promise.reject(new Error("unhandled"));',
    'setTimeout(() => { throw new Error("uncaught"); }, 0);',
  ]) {
    test(`${entry}: process error drains before final flush: ${trigger}`, async () => {
      expect((await runRunner(trigger, { entry })).code).toBe(1);
    });
  }

  test(`${entry}: SIGTERM during delayed startup drains eventual handle without ready log`, async () => {
    const result = await runRunner("", { entry, delayedSignal: true });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("booted");
    expect(result.stdout).not.toContain("ready");
  });

  test(`${entry}: fatal failure during signal drain upgrades exit status and waits`, async () => {
    const result = await runRunner(
      `
      process.kill(process.pid, "SIGTERM");
      setTimeout(() => rejectLoop(new Error("fatal during drain")), 10);
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 20);
    `,
      { entry },
    );
    expect(result.code).toBe(1);
  });

  test(`${entry}: signal during fatal drain cannot clear failure status`, async () => {
    const result = await runRunner(
      `
      rejectLoop(new Error("fatal refresh"));
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 10);
    `,
      { entry },
    );
    expect(result.code).toBe(1);
  });
}
