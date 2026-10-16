import { expect, test } from "bun:test";

// Global SDK configuration is intentionally isolated from other Bun test files.
for (const serviceName of ["memory-engine", "memory-engine-worker"]) {
  for (const failure of [
    "none",
    "configure",
    "sampler",
    "shutdown",
    "hung-shutdown",
  ]) {
    test(`${serviceName}: shared process telemetry finalizes fail-open (${failure})`, async () => {
      const script = `
        import { expect, mock } from "bun:test";
        const events = [];
        const stats = () => ({ threads: 0 });
        mock.module("@memory.build/embedding", () => ({ getTokenizerPoolStats: stats }));
        mock.module("./packages/server/runtime-telemetry.ts", () => ({
          prepareRuntimeTelemetryEnvironment() { events.push("environment"); },
          startRuntimeSampler(options) {
            events.push("sampler");
            expect(options.tokenizerStats).toBe(stats);
            expect(options.metricsEnabled).toBe(false);
            expect(options.intervalMs).toBe(60000);
            return { stop: async () => {
              events.push("final sample");
              ${failure === "sampler" ? 'throw new Error("sample failed");' : ""}
            } };
          },
        }));
        mock.module("@pydantic/logfire-node", () => ({
          configure(options) {
            expect(events).toEqual(["environment"]);
            events.push("configure");
            expect(options.serviceName).toBe(${JSON.stringify(serviceName)});
            expect(options.sendToLogfire).toBe("if-token-present");
            expect(options.metrics).toBe(false);
            expect(options.nodeAutoInstrumentations["@opentelemetry/instrumentation-runtime-node"].enabled).toBe(false);
            expect(options.nodeAutoInstrumentations["@opentelemetry/instrumentation-fs"].enabled).toBe(false);
            expect(options.scrubbing.extraPatterns).toEqual(["content", "embedding", "access_token", "refresh_token"]);
            expect(options.serviceVersion).toBeString();
            expect(options.codeSource.repository).toBe("https://github.com/timescale/memory-engine");
            ${failure === "configure" ? 'throw new Error("configuration failed");' : ""}
          },
          async shutdown(options) {
            expect(options).toEqual({ timeoutMillis: 1000 });
            events.push("sdk shutdown");
            ${failure === "shutdown" ? 'throw new Error("export failed");' : ""}
            ${failure === "hung-shutdown" ? "await new Promise(() => {});" : ""}
          },
        }));
        console.warn = () => {};
        const { configureTelemetry } = await import("./packages/server/telemetry.ts");
        const telemetry = configureTelemetry(${JSON.stringify(serviceName)});
        expect(events).toEqual(["environment", "configure", "sampler"]);
        events.push("application drained");
        const first = telemetry.stop();
        expect(telemetry.stop()).toBe(first);
        await first;
        expect(events).toEqual(["environment", "configure", "sampler", "application drained", "final sample", "sdk shutdown"]);
        await telemetry.stop();
        expect(events.filter(e => e === "sdk shutdown")).toHaveLength(1);
      `;
      const child = Bun.spawn([process.execPath, "-e", script], {
        cwd: new URL("../..", import.meta.url).pathname,
        env: {
          ...process.env,
          LOGFIRE_TELEMETRY_PROFILE: "lean",
          LOGFIRE_RUNTIME_SAMPLE_INTERVAL_MS: "60000",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 4000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ code, stdout, stderr }).toEqual({
          code: 0,
          stdout: "",
          stderr: "",
        });
      } finally {
        clearTimeout(timeout);
      }
    });
  }
}
