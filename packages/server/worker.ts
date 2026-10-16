// Standalone queue consumer, also available in the server Docker image:
// bun run packages/server/worker.ts (no API/auth configuration required).
import { info } from "@pydantic/logfire-node";
import { runProcessLifecycle } from "./process-lifecycle";
import { configureTelemetry } from "./telemetry";
import { startEmbeddingWorkers } from "./worker-start";

const telemetry = configureTelemetry("memory-engine-worker");

await runProcessLifecycle({
  start: async () => {
    const workers = await startEmbeddingWorkers();
    return { stop: () => workers.stop(), workerFinished: workers.finished };
  },
  finalize: () => telemetry.stop(),
  startupFailure: "Embedding workers failed to start",
  unexpectedWorkerExit: true,
  ready: () => info("Embedding workers ready"),
});
