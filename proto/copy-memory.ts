import { $ } from "bun";

const columns = [
  "id",
  "meta",
  "tree",
  "temporal",
  "content",
  "embedding",
  "embedding_version",
  "created_at",
  "created_by",
  "updated_at",
].join(", ");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseBatchSize(): number {
  const value = process.env.BATCH_SIZE ?? "1000";
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`BATCH_SIZE must be a positive integer, got: ${value}`);
  }
  return parsed;
}

function quoteIdent(name: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${name} must be a simple SQL identifier, got: ${value}`);
  }
  return `"${value}"`;
}

function quoteUuid(value: string): string {
  if (
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      value,
    )
  ) {
    throw new Error(`Expected UUID boundary, got: ${value}`);
  }
  return `'${value}'::uuid`;
}

async function psqlJson<T>(databaseUrl: string, sql: string): Promise<T> {
  const output =
    await $`psql ${databaseUrl} -X -q -t -A -v ON_ERROR_STOP=1 -c ${sql}`.text();
  return JSON.parse(output.trim()) as T;
}

function progress(copied: number, total: number, startedAt: number): string {
  const pct = total === 0 ? 100 : (copied / total) * 100;
  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  const rowsPerSecond = elapsedSeconds > 0 ? copied / elapsedSeconds : 0;
  return `${copied}/${total} (${pct.toFixed(1)}%, ${rowsPerSecond.toFixed(0)} rows/s)`;
}

const databaseUrlFrom = requireEnv("DATABASE_URL_FROM");
const databaseUrlTo = requireEnv("DATABASE_URL_TO");
const schemaFrom = quoteIdent("SCHEMA_FROM", requireEnv("SCHEMA_FROM"));
const schemaTo = quoteIdent("SCHEMA_TO", requireEnv("SCHEMA_TO"));
const batchSize = parseBatchSize();

type Stats = { min_id: string | null; count: string };
type Boundary = { last_id: string | null; count: string };

const stats = await psqlJson<Stats>(
  databaseUrlFrom,
  `select json_build_object('min_id', (select id::text from ${schemaFrom}.memory order by id limit 1), 'count', count(*)::text)::text from ${schemaFrom}.memory`,
);
const total = Number.parseInt(stats.count, 10);
if (!Number.isSafeInteger(total)) {
  throw new Error(`Source memory count is not a safe integer: ${stats.count}`);
}

console.error(
  `Copying ${total} memories from ${schemaFrom}.memory to ${schemaTo}.memory in batches of ${batchSize}`,
);
if (stats.min_id) console.error(`First source id: ${stats.min_id}`);

let copied = 0;
let batch = 0;
let lastId: string | null = null;
const startedAt = performance.now();

while (copied < total) {
  const whereAfterLast: string = lastId
    ? `where id > ${quoteUuid(lastId)}`
    : "";
  const boundary: Boundary = await psqlJson<Boundary>(
    databaseUrlFrom,
    `with batch as (select id from ${schemaFrom}.memory ${whereAfterLast} order by id limit ${batchSize}) select json_build_object('last_id', (select id::text from batch order by id desc limit 1), 'count', (select count(*)::text from batch))::text`,
  );
  const batchRows = Number.parseInt(boundary.count, 10);
  if (!Number.isSafeInteger(batchRows)) {
    throw new Error(`Batch count is not a safe integer: ${boundary.count}`);
  }
  if (batchRows === 0 || !boundary.last_id) break;

  const lowerBound = lastId ? `id > ${quoteUuid(lastId)} and ` : "";
  const upperBound = `id <= ${quoteUuid(boundary.last_id)}`;
  const sourceCopy = `\\copy (select ${columns} from ${schemaFrom}.memory where ${lowerBound}${upperBound} order by id) to stdout with (format binary)`;
  const targetCopy = `\\copy ${schemaTo}.memory (${columns}) from stdin with (format binary)`;

  batch++;
  await $`psql ${databaseUrlFrom} -X -q -v ON_ERROR_STOP=1 -c ${sourceCopy} | psql ${databaseUrlTo} -X -q -v ON_ERROR_STOP=1 -c ${targetCopy}`;

  copied += batchRows;
  lastId = boundary.last_id;
  console.error(
    `Batch ${batch}: copied ${batchRows} rows, ${progress(copied, total, startedAt)}`,
  );
}

console.error(`Finished copying ${copied} memories in ${batch} batches.`);
