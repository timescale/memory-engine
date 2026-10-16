import { reportError } from "@memory.build/database/telemetry";

interface ProcessHandle {
  stop(): Promise<void>;
  workerFinished?: Promise<void>;
}

/** Install handlers before bootstrap; every exit path shares the same drain. */
export async function runProcessLifecycle<T extends ProcessHandle>(options: {
  start(signal: AbortSignal): Promise<T>;
  /** Process telemetry final flush, after application drain (also on boot failure). */
  finalize?(): Promise<void>;
  ready(handle: T): void;
  startupFailure: string;
  unexpectedWorkerExit?: boolean;
}): Promise<void> {
  let requested = false;
  let exitCode = 0;
  let stopping: Promise<void> | undefined;
  // Defer bootstrap until handlers are installed (including synchronous throws).
  const controller = new AbortController();
  const startup = Promise.resolve().then(() =>
    options.start(controller.signal),
  );

  function shutdown(code: number): Promise<void> {
    requested = true;
    if (code !== 0) exitCode = code; // A later signal cannot erase a fatal error.
    // Reach partially started pools synchronously, before awaiting bootstrap.
    controller.abort();
    stopping ??= (async () => {
      const handle = await startup.catch(() => undefined);
      try {
        await handle?.stop();
      } catch (error) {
        reportError("Error during shutdown", error as Error);
        exitCode = 1;
      }
      try {
        await options.finalize?.();
      } catch {
        // Telemetry failure must not prevent exit or change application status.
      }
      process.exit(exitCode);
    })();
    return stopping;
  }

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("unhandledRejection", (error) => {
    reportError("Unhandled promise rejection", error as Error);
    void shutdown(1);
  });
  process.on("uncaughtException", (error) => {
    reportError("Uncaught exception", error);
    void shutdown(1);
  });

  let handle: T;
  try {
    handle = await startup;
  } catch (error) {
    const cancelled =
      controller.signal.aborted && error === controller.signal.reason;
    if (!cancelled) reportError(options.startupFailure, error as Error);
    await shutdown(cancelled ? 0 : 1);
    return;
  }
  void handle.workerFinished?.then(
    () => {
      if (options.unexpectedWorkerExit && !requested) {
        reportError(
          "Embedding worker loops exited unexpectedly",
          new Error("Worker pool stopped"),
        );
        void shutdown(1);
      }
    },
    (error) => {
      reportError("Fatal embedding worker loop failure", error as Error);
      void shutdown(1);
    },
  );
  if (!requested) options.ready(handle);
}
