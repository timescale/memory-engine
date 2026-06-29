import { parentPort } from "node:worker_threads";
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

if (!parentPort) {
  throw new Error("tokenize.worker must run inside a worker thread");
}

const port = parentPort;

port.on("message", (request: TruncateRequest) => {
  const response: TruncateResponse = { id: request.id };
  try {
    response.results = request.texts.map((text) =>
      truncateToTokenLimit(text, request.maxTokens),
    );
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error);
  }
  port.postMessage(response);
});
