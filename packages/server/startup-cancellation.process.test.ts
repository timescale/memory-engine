import { expect, test } from "bun:test";

// Mock only external boundaries, in a child so real Worker/WorkerPool and both
// production bootstraps/entrypoints run without polluting other test modules.
async function run(entry: "worker" | "index", later: boolean, failure = false) {
  const child = Bun.spawn(
    [
      "./bun",
      "-e",
      `
    import { mock } from "bun:test";
    const events = [];
    const pools = [];
    let discoveries = 0;
    let claims = 0;
    let releaseClaim, claimEntered;
    const claimGate = new Promise(resolve => { releaseClaim = resolve; });
    const claimed = new Promise(resolve => { claimEntered = resolve; });
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    mock.module("@memory.build/database/telemetry", () => ({
      reportError(message, error) { events.push("error:" + message + ":" + error.message); }
    }));
    mock.module("@pydantic/logfire-node", () => ({
      info(message) { events.push("info:" + message); }, warning() {},
      span: (_, opts) => opts.callback({ setAttributes() {} })
    }));
    mock.module("@memory.build/database", () => ({
      bootstrapSpaceDatabase: async () => {}, migrateAuth: async () => {},
      migrateCore: async () => {}, migrateSpace: async () => {},
      slugToSchema: slug => "me_" + slug
    }));
    mock.module("postgres", () => ({ default: (_, opts) => {
      const name = opts.connection.application_name;
      const sql = {
        name, closes: 0,
        end: async () => { sql.closes++; events.push("close:" + name); },
        begin: async callback => callback(sql),
        unsafe: async query => {
          if (query.includes("claim_embedding_batch")) {
            claims++; events.push("claim"); claimEntered();
            await claimGate;
            events.push("claim-return");
            return [{ queue_id: "queue", memory_id: "memory", content_version: 1, content: "test" }];
          }
          if (query.includes("complete_embedding")) {
            events.push("write-start"); await Bun.sleep(20);
            check(pools.every(p => !p.closes || p.name === "me-migration"), "closed before write-back");
            events.push("write-done");
            return [{ status: "succeeded" }];
          }
          return [];
        }
      };
      pools.push(sql); return sql;
    } }));
    mock.module("@memory.build/embedding", () => ({
      RateLimitError: class extends Error {}, getTokenizerThreadCount: () => 0,
      shutdownTokenizerPool: async () => { events.push("tokenizer"); },
      generateEmbeddings: async rows => {
        events.push("provider-start"); await Bun.sleep(20);
        events.push("provider-done");
        return rows.map(row => ({ id: row.id, embedding: [1, 2, 3] }));
      }
    }));
    mock.module("@memory.build/engine/core", () => ({ coreStore: db => ({
      listSpaces: async () => {
        if (db.name === "me-migration") return [];
        discoveries++; events.push("discover:" + discoveries);
        if (discoveries === ${later ? 2 : 1}) {
          ${later ? "await claimed;" : ""}
          await new Promise(resolve => {
            process.once("SIGTERM", () => {
              events.push("signal");
              // Keep discovery pending after signal delivery, exposing pools
              // that wait for startup before propagating stop.
              setTimeout(() => { releaseClaim(); resolve(); }, 20);
            });
            process.kill(process.pid, "SIGTERM");
          });
          ${failure ? 'throw new Error("real discovery failure");' : ""}
        }
        return [{ slug: "test" }];
      }
    }) }));
    mock.module("./packages/server/auth/betterauth.ts", () => ({ normalizeSignupEmailDomain: value => value, createBetterAuth: () => ({
      auth: {}, pool: { end: async () => { events.push("auth-close"); } }
    }) }));
    mock.module("./packages/server/router.ts", () => ({ createRouter: () => ({}) }));
    mock.module("./packages/server/middleware/index.ts", () => ({ checkSizeLimit: () => null }));
    Bun.serve = () => { throw new Error("HTTP must not start after shutdown"); };
    mock.module("./packages/server/telemetry.ts", () => ({ configureTelemetry: () => ({
      stop: async () => {
        events.push("telemetry");
        check(discoveries === ${later ? 2 : 1}, "later worker discovery started");
        check(claims === ${later ? 1 : 0}, "claims after shutdown");
        check(pools.every(p => p.closes === 1), "pools must close once before telemetry");
        console.log(JSON.stringify(events));
      }
    }) }));
    await import("./packages/server/${entry}.ts");
  `,
    ],
    {
      cwd: new URL("../..", import.meta.url).pathname,
      env: {
        ...process.env,
        DATABASE_URL: "postgres://unused",
        API_BASE_URL: "http://localhost",
        BETTER_AUTH_SECRET: "test",
        EMBEDDING_API_KEY: "test",
        WORKER_COUNT: "3",
        WORKER_REFRESH_INTERVAL_MS: "60000",
      },
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
    expect(code, stderr + stdout).toBe(failure ? 1 : 0);
    const events: string[] = JSON.parse(stdout.trim());
    expect(events.at(-1)).toBe("telemetry");
    expect(events.filter((e) => e.startsWith("discover:"))).toHaveLength(
      later ? 2 : 1,
    );
    expect(events.filter((e) => e === "claim")).toHaveLength(later ? 1 : 0);
    expect(
      events.some((e) => e.includes("ready") || e.includes("Server started")),
    ).toBe(false);
    expect(events.some((e) => e.includes("failed to start"))).toBe(failure);
    if (later) {
      expect(events.indexOf("provider-start")).toBeGreaterThan(
        events.indexOf("signal"),
      );
      expect(events.indexOf("write-done")).toBeGreaterThan(
        events.indexOf("provider-done"),
      );
      expect(events.indexOf("close:me-worker")).toBeGreaterThan(
        events.indexOf("write-done"),
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

for (const entry of ["worker", "index"] as const) {
  test(`${entry}: SIGTERM during first real discovery prevents claims and later workers`, () =>
    run(entry, false));
  test(`${entry}: SIGTERM during later real discovery drains claimed SQL/provider/write-back`, () =>
    run(entry, true));
  test(`${entry}: real startup failure overlapping SIGTERM remains nonzero`, () =>
    run(entry, true, true));
}
