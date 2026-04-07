import {
  configure,
  info,
  reportError,
  withSpan,
} from "@memory-engine/telemetry";

// Initialize telemetry before starting server
await configure();

const port = process.env.PORT || 3000;

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    return withSpan(
      "http.request",
      {
        "http.method": method,
        "http.url": request.url,
        "http.path": path,
      },
      async () => {
        try {
          // Health check endpoint
          if (path === "/health") {
            info("Health check", { path });
            return new Response("ok", { status: 200 });
          }

          // TODO: Add RPC handling, auth, etc.
          // For now, return a simple response
          return new Response("memory engine", { status: 200 });
        } catch (error) {
          reportError("Request failed", error as Error, {
            "http.method": method,
            "http.path": path,
          });
          return new Response("Internal Server Error", { status: 500 });
        }
      },
    );
  },
});

info("Server started", { port });
