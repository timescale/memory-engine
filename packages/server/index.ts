// Production entrypoint. Callable bootstrap stays free of process handlers.
import { info } from "@pydantic/logfire-node";
import { runProcessLifecycle } from "./process-lifecycle";
import { startServer } from "./start";
import { configureTelemetry } from "./telemetry";

const telemetry = configureTelemetry("memory-engine");

await runProcessLifecycle({
  start: () => startServer(),
  finalize: () => telemetry.stop(),
  startupFailure: "Server failed to start",
  ready: (server) => info("Server ready", { url: server.url }),
});
