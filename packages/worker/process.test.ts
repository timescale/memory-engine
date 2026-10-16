import { expect, spyOn, test } from "bun:test";
import * as embedding from "@memory.build/embedding";
import * as logfire from "@pydantic/logfire-node";
import { processBatch } from "./process";

// No module mocks, database, sockets, provider calls, or telemetry exporter.
test("embedding.batch records numeric UTF-8 input bytes without input contents", async () => {
  const claimed = [
    {
      queue_id: "q1",
      memory_id: "m1",
      content_version: 1,
      content: "あ🙂",
    },
    {
      queue_id: "q2",
      memory_id: "m2",
      content_version: 1,
      content: "é",
    },
  ];
  const tx = {
    unsafe: async (query: string) =>
      query.includes("claim_embedding_batch") ? claimed : [],
  };
  const sql = {
    begin: async (callback: (transaction: typeof tx) => Promise<unknown>) =>
      callback(tx),
  };
  const spanSpy = spyOn(logfire, "span");
  const embedSpy = spyOn(embedding, "generateEmbeddings").mockResolvedValue(
    claimed.map((row) => ({ id: row.memory_id, embedding: [0, 1] })),
  );
  try {
    const result = await processBatch(
      sql as never,
      { schema: "me_test12345678" },
      {
        embedding: {
          provider: "openai",
          model: "text-embedding-3-small",
          dimensions: 2,
          apiKey: "test-key",
        },
        discover: async () => [],
      },
    );
    expect(result).toEqual({ claimed: 2, succeeded: 2, failed: 0 });
    const call = spanSpy.mock.calls.find(
      ([name]) => name === "embedding.batch",
    );
    const attrs = call?.[1].attributes as Record<string, unknown> | undefined;
    expect(attrs?.["batch.input_bytes"]).toBe(9);
    expect(typeof attrs?.["batch.input_bytes"]).toBe("number");
    expect(Object.values(attrs ?? {})).not.toContain("あ🙂");
    expect(Object.values(attrs ?? {})).not.toContain("test-key");
    expect(embedSpy).toHaveBeenCalledTimes(1);
  } finally {
    embedSpy.mockRestore();
    spanSpy.mockRestore();
  }
});
