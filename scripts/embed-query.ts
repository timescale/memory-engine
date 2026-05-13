import { generateEmbedding } from "@memory.build/embedding";

const DEFAULT_OUTPUT = "emb.txt";

async function loadDotEnv(path = ".env"): Promise<void> {
  const file = Bun.file(path);
  if (!(await file.exists())) return;

  const text = await file.text();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (!key || process.env[key] !== undefined) continue;

    let value = rawValue?.trim() ?? "";
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.at(-1) === quote) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function parseIntegerEnv(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an integer, got ${value}`);
  }
  return parsed;
}

await loadDotEnv();

const outputPath = process.argv[2] ?? DEFAULT_OUTPUT;
const queryArg = process.argv.slice(3).join(" ").trim();
const query = queryArg || prompt("Semantic query: ")?.trim();
if (!query) {
  throw new Error("Semantic query is required");
}

const apiKey = process.env.EMBEDDING_API_KEY;
if (!apiKey) {
  throw new Error("EMBEDDING_API_KEY is required in the environment or .env");
}

const embedding = await generateEmbedding(query, {
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 1536,
  apiKey,
  baseUrl: process.env.EMBEDDING_BASE_URL,
  options: {
    timeoutMs: parseIntegerEnv("EMBEDDING_TIMEOUT_MS"),
    maxRetries: parseIntegerEnv("EMBEDDING_MAX_RETRIES"),
  },
});

await Bun.write(outputPath, `[${embedding.embedding.join(",")}]\n`);

console.log(
  `Wrote ${embedding.embedding.length}-dim embedding to ${outputPath}`,
);
