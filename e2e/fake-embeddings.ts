/**
 * A local stand-in for the OpenAI embeddings endpoint, so the e2e suite never
 * leaves the machine. CI runs under egress filtering, where a real
 * api.openai.com call hangs rather than fails; and the suite should not need
 * a paid credential to exercise the queue → worker → HNSW → search pipeline.
 *
 * Vectors are a hashed bag of words: each lowercase token is hashed to one of
 * `dimensions` buckets and the vector is L2-normalised. Two texts that share
 * words get a higher cosine similarity, which is enough to show that a
 * semantic search round-trips through the embedding column and the index.
 * It says nothing about ranking quality; the opt-in live suite in
 * `packages/embedding/generate.test.ts` covers that.
 *
 * Implements only what the Vercel AI SDK OpenAI provider sends: POST
 * `/v1/embeddings` with `{ input: string | string[], model }`, answering in the
 * OpenAI response shape with a `usage.total_tokens` count.
 */
export function startFakeEmbeddings(dimensions: number): {
  baseUrl: string;
  stop: () => void;
} {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || !url.pathname.endsWith("/embeddings")) {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json()) as { input: string | string[] };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      let totalTokens = 0;
      const data = inputs.map((text, index) => {
        const words = tokenize(text);
        totalTokens += words.length;
        return { object: "embedding", index, embedding: embed(words) };
      });
      return Response.json({
        object: "list",
        data,
        model: "fake-embeddings",
        usage: { prompt_tokens: totalTokens, total_tokens: totalTokens },
      });
    },
  });

  function tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 0);
  }

  function embed(words: string[]): number[] {
    const vector = new Array<number>(dimensions).fill(0);
    for (const word of words) {
      const bucket = fnv1a(word) % dimensions;
      vector[bucket] = (vector[bucket] ?? 0) + 1;
    }
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vector.map((v) => v / norm);
  }

  function fnv1a(s: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
  }

  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    stop: () => server.stop(true),
  };
}
