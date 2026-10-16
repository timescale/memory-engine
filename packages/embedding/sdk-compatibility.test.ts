import { expect, test } from "bun:test";
import { generateEmbedding, generateEmbeddings } from "./generate";
import type { EmbeddingConfig } from "./types";

// Exercise the installed AI SDK/provider pair over real loopback HTTP. No API
// credentials or external embedding requests are needed for these regressions.
test("OpenAI embedding batches respect the SDK byte budget and preserve row order", async () => {
  const batches: string[][] = [];
  let active = 0;
  let maxActive = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { input: string[] };
      batches.push(body.input);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await Bun.sleep(5);
        return Response.json({
          object: "list",
          data: body.input.map((value, index) => ({
            object: "embedding",
            index,
            embedding: [Number.parseInt(value, 10), 1],
          })),
          model: "text-embedding-3-small",
          usage: {
            prompt_tokens: body.input.length,
            total_tokens: body.input.length,
          },
        });
      } finally {
        active--;
      }
    },
  });
  try {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      id: String(index),
      // Each value is below our safe-char floor (no tokenizer worker needed),
      // but the aggregate exceeds OpenAI's new 300,000-input-byte batch budget.
      content: `${index}:${"x".repeat(2000)}`,
    }));
    const config: EmbeddingConfig = {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 2,
      apiKey: "loopback-test-only",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      options: { maxRetries: 0, maxParallelCalls: 1 },
    };
    const results = await generateEmbeddings(rows, config);
    expect(batches).toHaveLength(2);
    expect(maxActive).toBe(1);
    expect(batches.flat()).toEqual(rows.map((row) => row.content));
    for (const batch of batches) {
      expect(
        batch.reduce((bytes, value) => bytes + Buffer.byteLength(value), 0),
      ).toBeLessThanOrEqual(300_000);
    }
    expect(results).toHaveLength(rows.length);
    for (const [index, result] of results.entries()) {
      expect(result.id).toBe(String(index));
      expect(result.error).toBeUndefined();
      expect(result.embedding).toEqual([index, 1]);
    }
  } finally {
    server.stop(true);
  }
});

test("an embedding timeout aborts the installed provider request without retrying", async () => {
  let requests = 0;
  let release: (() => void) | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      requests++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return Response.json({ data: [], usage: { prompt_tokens: 0 } });
    },
  });
  try {
    await expect(
      generateEmbedding("short input", {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 2,
        apiKey: "loopback-test-only",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        options: { maxRetries: 0, timeoutMs: 500 },
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(requests).toBe(1);
  } finally {
    release?.();
    server.stop(true);
  }
});
