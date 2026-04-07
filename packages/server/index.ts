import {
  configure,
  info,
  reportError,
  withSpan,
} from "@memory-engine/telemetry";
import { checkRateLimit, checkSizeLimit } from "./middleware";
import { handleRequest } from "./router";
import { internalError } from "./util/response";

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
          // 1. Check size limit
          const sizeError = checkSizeLimit(request);
          if (sizeError) {
            return sizeError;
          }

          // 2. Check rate limit
          const rateLimitError = checkRateLimit(request);
          if (rateLimitError) {
            return rateLimitError;
          }

          // 3. Route and handle request
          return await handleRequest(request);
        } catch (error) {
          reportError("Request failed", error as Error, {
            "http.method": method,
            "http.path": path,
          });
          return internalError();
        }
      },
    );
  },
});

info("Server started", { port });
