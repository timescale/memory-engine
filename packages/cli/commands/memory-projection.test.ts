import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { parse as yamlParse } from "yaml";
import { createMemoryCommand } from "./memory.ts";

const originalFetch = globalThis.fetch;
const envKeys = [
  "ME_API_KEY",
  "ME_CONFIG_DIR",
  "ME_SERVER",
  "ME_SPACE",
] as const;
const originalEnv = Object.fromEntries(
  envKeys.map((key) => [key, process.env[key]]),
);

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "me-memory-projection-"));
  process.env.ME_API_KEY = "me.test.secret";
  process.env.ME_CONFIG_DIR = configDir;
  process.env.ME_SERVER = "https://api.example.com";
  process.env.ME_SPACE = "defaultspace";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(configDir, { recursive: true, force: true });
});

function program(): Command {
  return new Command()
    .option("--server <url>")
    .option("--json")
    .option("--yaml")
    .addCommand(createMemoryCommand());
}

function captureRpcResult(result: unknown): Record<string, unknown>[] {
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    requests.push(body);
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return requests;
}

async function captureLogs(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines;
}

async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join("");
}

const memory = {
  id: "0194a000-0001-7000-8000-000000000001",
  content: "x".repeat(150),
  meta: { source: "docs", private: true },
  tree: "/share/design",
  name: "projection",
  temporal: null,
  version: 2,
  versionHash: "a".repeat(32),
  hasEmbedding: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: null,
  updatedAt: null,
};

test("search and export reject empty metadata predicates before RPC", async () => {
  const requests = captureRpcResult({ results: [], total: 0, limit: 10 });

  for (const subcommand of ["search", "export"]) {
    await expect(
      program().parseAsync(["memory", subcommand, "--meta-predicate", "   "], {
        from: "user",
      }),
    ).rejects.toThrow(/Invalid --meta-predicate/);
  }

  expect(requests).toHaveLength(0);
});

test("search and export preserve every temporal filter", async () => {
  const requests = captureRpcResult({ results: [], total: 0, limit: 10 });
  const flags = [
    "--temporal-before",
    "2026-02-01T00:00:00Z",
    "--temporal-after",
    "2026-01-01T00:00:00Z",
    "--temporal-contains",
    "2026-01-15T00:00:00Z",
    "--temporal-overlaps",
    "2026-01-10T00:00:00Z,2026-01-20T00:00:00Z",
    "--temporal-within",
    "2026-01-01T00:00:00Z,2026-02-01T00:00:00Z",
  ];
  const temporal = {
    before: "2026-02-01T00:00:00Z",
    after: "2026-01-01T00:00:00Z",
    contains: "2026-01-15T00:00:00Z",
    overlaps: { start: "2026-01-10T00:00:00Z", end: "2026-01-20T00:00:00Z" },
    within: { start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" },
  };

  await program().parseAsync(["memory", "search", ...flags], {
    from: "user",
  });
  await program().parseAsync(["memory", "export", ...flags], {
    from: "user",
  });

  expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([
    { method: "memory.search", params: { temporal, limit: 10 } },
    {
      method: "memory.search",
      params: { temporal, limit: 1000, orderBy: "asc" },
    },
  ]);
});

test("default text search projects locally and always displays the score", async () => {
  const requests = captureRpcResult({
    results: [
      { ...memory, score: -1 },
      { ...memory, score: 1 },
      { ...memory, score: 2.5 },
    ],
    total: 3,
    limit: 10,
  });
  const lines = await captureLogs(() =>
    program().parseAsync(["memory", "search", "projection"], {
      from: "user",
    }),
  );

  const request = requests[0] as {
    method?: string;
    params?: Record<string, unknown>;
  };
  expect(request.method).toBe("memory.search");
  expect(request.params).not.toHaveProperty("select");
  expect(lines).toContain(memory.id);
  expect(lines).toContain("  tree: /share/design");
  expect(lines).toContain(`  ${"x".repeat(120)}...`);
  expect(lines).toContain("  score: -1.000");
  expect(lines).toContain("  score: 1.000");
  expect(lines).toContain("  score: 2.500");
  expect(lines.join("\n")).not.toContain("contentLength");
});

test("explicit CLI selection is local and presents only selected fields", async () => {
  const requests = captureRpcResult({
    results: [{ ...memory, score: 2.5 }],
    total: 1,
    limit: 10,
  });
  const lines = await captureLogs(() =>
    program().parseAsync(
      ["memory", "search", "projection", "--select", "id,meta.source"],
      { from: "user" },
    ),
  );

  const request = requests[0] as { params?: Record<string, unknown> };
  expect(request.params).not.toHaveProperty("select");
  const output = lines.join("\n");
  expect(output).toContain(`id: ${memory.id}`);
  expect(output).toContain("source: docs");
  expect(output).not.toContain("private");
  expect(output).not.toContain("content:");
});

test("CLI get projects both ID and path responses locally", async () => {
  const requests = captureRpcResult(memory);

  for (const reference of [memory.id, "/share/design/projection"]) {
    const lines = await captureLogs(() =>
      program().parseAsync(
        ["memory", "get", reference, "--select", "id,content:4"],
        { from: "user" },
      ),
    );
    expect(lines.join("\n")).toContain(`id: ${memory.id}`);
    expect(lines.join("\n")).toContain(`content: ${"x".repeat(4)}`);
    expect(lines.join("\n")).toContain("contentLength: 150");
  }

  expect(
    requests.map((request) => ({
      method: request.method,
      params: request.params,
    })),
  ).toEqual([
    { method: "memory.get", params: { id: memory.id } },
    {
      method: "memory.getByPath",
      params: { path: "/share/design/projection" },
    },
  ]);
});

test("structured CLI get output projects locally without RPC presentation params", async () => {
  const requests = captureRpcResult(memory);

  const json = await captureStdout(() =>
    program().parseAsync(
      ["--json", "memory", "get", memory.id, "--select", "id,content:4"],
      { from: "user" },
    ),
  );
  const yaml = await captureStdout(() =>
    program().parseAsync(
      ["--yaml", "memory", "get", memory.id, "--select", "id,content:4"],
      { from: "user" },
    ),
  );

  const expected = {
    id: memory.id,
    content: "xxxx",
    contentLength: 150,
  };
  expect(JSON.parse(json)).toEqual(expected);
  expect(yamlParse(yaml)).toEqual(expected);
  expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([
    { method: "memory.get", params: { id: memory.id } },
    { method: "memory.get", params: { id: memory.id } },
  ]);
});

test("CLI selection preserves metadata suffixes and open-ended slices", async () => {
  const requests = captureRpcResult({
    ...memory,
    content: "0123456789",
    meta: { $thread: "thread-1", "build.id": 42, omitted: true },
  });
  const lines = await captureLogs(() =>
    program().parseAsync(
      [
        "memory",
        "get",
        memory.id,
        "--select",
        "meta.$thread,meta.build.id,content:4:",
      ],
      { from: "user" },
    ),
  );

  expect(yamlParse(lines.join("\n"))).toEqual({
    meta: { $thread: "thread-1", "build.id": 42 },
    content: "456789",
    contentLength: 10,
  });
  expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([
    { method: "memory.get", params: { id: memory.id } },
  ]);
});

test("CLI get rejects --raw with --select before making an RPC request", async () => {
  const requests = captureRpcResult(memory);
  const originalExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => {
    exitCode = code;
  }) as never;
  try {
    await program().parseAsync(
      ["memory", "get", memory.id, "--raw", "--select", "id"],
      { from: "user" },
    );
  } finally {
    process.exit = originalExit;
  }

  expect(exitCode).toBe(1);
  expect(requests).toEqual([]);
});

test("structured CLI formats preserve the search envelope after projection", async () => {
  const requests = captureRpcResult({
    results: [{ ...memory, score: 2.5 }],
    total: 1,
    limit: 10,
  });

  const json = await captureStdout(() =>
    program().parseAsync(
      ["--json", "memory", "search", "projection", "--select", "id,score"],
      { from: "user" },
    ),
  );
  const yaml = await captureStdout(() =>
    program().parseAsync(
      ["--yaml", "memory", "search", "projection", "--select", "id,score"],
      { from: "user" },
    ),
  );

  const expected = {
    results: [{ id: memory.id, score: 2.5 }],
    total: 1,
    limit: 10,
  };
  expect(JSON.parse(json)).toEqual(expected);
  expect(yamlParse(yaml)).toEqual(expected);
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.params).not.toHaveProperty("select");
  }
});
