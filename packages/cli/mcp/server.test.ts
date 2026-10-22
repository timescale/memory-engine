import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parse as yamlParse } from "yaml";
import {
  createMcpServer,
  type McpServerOptions,
  type McpSpaceMode,
} from "./server.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type RequestCapture = {
  method: string;
  headers: Record<string, string>;
};

type RpcRequestCapture = {
  method: string;
  params: Record<string, unknown>;
};

const fullMemory = {
  id: "0194a000-0001-7000-8000-000000000001",
  content: "ab😀cdefghij",
  meta: { source: "docs", $thread: "thread-1" },
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

function captureRpcResult(result: unknown): RpcRequestCapture[] {
  const requests: RpcRequestCapture[] = [];
  globalThis.fetch = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    };
    requests.push({ method: body.method, params: body.params ?? {} });
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return requests;
}

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (
    result.content as Array<{ type: string; text: string }> | undefined
  )?.[0];
  if (!content || content.type !== "text") throw new Error("missing text");
  return content.text;
}

function assertMcpServerOptions(_options: McpServerOptions): void {}

test("McpServerOptions ties locked space to locked mode", () => {
  assertMcpServerOptions({
    server: "https://api.example.com",
    bearer: {
      getToken: async () => "token",
      onUnauthorized: async () => undefined,
    },
    spaceMode: "locked",
    lockedSpace: "lockedspace1",
  });
  assertMcpServerOptions({
    server: "https://api.example.com",
    bearer: {
      getToken: async () => "token",
      onUnauthorized: async () => undefined,
    },
    spaceMode: "multi",
  });

  // @ts-expect-error locked MCP must have a space to lock.
  assertMcpServerOptions({
    server: "https://api.example.com",
    bearer: {
      getToken: async () => "token",
      onUnauthorized: async () => undefined,
    },
    spaceMode: "locked",
  });
  // @ts-expect-error multi-space MCP cannot carry a locked space.
  assertMcpServerOptions({
    server: "https://api.example.com",
    bearer: {
      getToken: async () => "token",
      onUnauthorized: async () => undefined,
    },
    spaceMode: "multi",
    lockedSpace: "should-not-be-set",
  });
});

function captureFetch(
  spaces = [
    { slug: "defaultspace", name: "Default" },
    { slug: "otherspace01", name: "Other" },
  ],
): RequestCapture[] {
  const requests: RequestCapture[] = [];
  globalThis.fetch = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    requests.push({
      method: body.method,
      headers: (init?.headers as Record<string, string> | undefined) ?? {},
    });

    const result =
      body.method === "space.list"
        ? {
            spaces,
          }
        : body.method === "access.effective"
          ? { principal: { kind: "u" }, access: [] }
          : { nodes: [] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return requests;
}

async function connect(
  spaceMode: McpSpaceMode,
  lockedSpace?: string,
  extra: Partial<Pick<McpServerOptions, "fsRoot">> = {},
) {
  const space =
    spaceMode === "multi"
      ? { spaceMode }
      : { spaceMode, lockedSpace: lockedSpace ?? "defaultspace" };
  const server = createMcpServer({
    server: "https://api.example.com",
    bearer: {
      getToken: async () => "token",
      onUnauthorized: async () => undefined,
    },
    ...space,
    ...extra,
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

function memoryTools(tools: Awaited<ReturnType<Client["listTools"]>>) {
  return tools.tools.filter((tool) => tool.name.startsWith("me_memory_"));
}

test("multi-space MCP servers require space selection and expose discovery", async () => {
  const { client, server } = await connect("multi");
  try {
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "me_space_list")).toBe(
      true,
    );
    expect(memoryTools(tools)).toHaveLength(17);
    for (const tool of memoryTools(tools)) {
      expect(tool.inputSchema.properties).toHaveProperty("space");
      expect(tool.inputSchema.required).toContain("space");
    }
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("locked MCP servers hide space selection and discovery", async () => {
  const { client, server } = await connect("locked");
  try {
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "me_space_list")).toBe(
      false,
    );
    expect(memoryTools(tools)).toHaveLength(17);
    for (const tool of memoryTools(tools)) {
      expect(tool.inputSchema.properties ?? {}).not.toHaveProperty("space");
    }
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("each tool call uses its selected space without header leakage", async () => {
  const requests = captureFetch();
  const { client, server } = await connect("multi");
  try {
    await Promise.all([
      client.callTool({
        name: "me_memory_tree",
        arguments: { space: "otherspace01" },
      }),
      client.callTool({
        name: "me_memory_tree",
        arguments: { space: "defaultspace" },
      }),
    ]);

    const treeRequests = requests.filter(
      (request) => request.method === "memory.tree",
    );
    expect(
      treeRequests.map((request) => request.headers["X-Me-Space"]).sort(),
    ).toEqual(["defaultspace", "otherspace01"]);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("memory context reports the space selected for its call", async () => {
  const requests = captureFetch();
  const { client, server } = await connect("multi");
  try {
    const result = await client.callTool({
      name: "me_memory_context",
      arguments: { space: "otherspace01" },
    });
    const content = (
      result.content as Array<{ type: string; text: string }> | undefined
    )?.[0];
    if (!content || content.type !== "text") throw new Error("missing text");
    const context = JSON.parse(content.text) as Record<string, unknown>;
    expect(context).not.toHaveProperty("activeSpace");
    expect(context).not.toHaveProperty("selectedSpace");
    expect(requests).toEqual([
      {
        method: "access.effective",
        headers: expect.objectContaining({ "X-Me-Space": "otherspace01" }),
      },
    ]);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("locked memory context uses the configured space", async () => {
  const requests = captureFetch();
  const { client, server } = await connect("locked", "lockedspace01");
  try {
    const result = await client.callTool({
      name: "me_memory_context",
      arguments: {},
    });
    const content = (
      result.content as Array<{ type: string; text: string }> | undefined
    )?.[0];
    if (!content || content.type !== "text") throw new Error("missing text");
    expect(JSON.parse(content.text)).toMatchObject({
      activeSpace: "lockedspace01",
    });
    expect(requests[0]?.headers).toEqual(
      expect.objectContaining({ "X-Me-Space": "lockedspace01" }),
    );
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("space discovery uses the account endpoint without a space header", async () => {
  const requests = captureFetch();
  const { client, server } = await connect("multi");
  try {
    const result = await client.callTool({
      name: "me_space_list",
      arguments: {},
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(
          {
            spaces: [
              { slug: "defaultspace", name: "Default" },
              { slug: "otherspace01", name: "Other" },
            ],
          },
          null,
          2,
        ),
      },
    ]);
    expect(requests).toEqual([
      {
        method: "space.list",
        headers: expect.not.objectContaining({
          "X-Me-Space": expect.anything(),
        }),
      },
    ]);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("memory get projects locally without sending presentation params to RPC", async () => {
  const requests = captureRpcResult(fullMemory);
  const { client, server } = await connect("locked");
  try {
    const result = await client.callTool({
      name: "me_memory_get",
      arguments: {
        id: fullMemory.id,
        select: ["content:4", "meta.$thread"],
        format: "compact",
      },
    });
    expect(JSON.parse(toolText(result))).toEqual({
      content: "ab😀",
      contentLength: 12,
      meta: { $thread: "thread-1" },
    });
    expect(requests).toEqual([
      { method: "memory.get", params: { id: fullMemory.id } },
    ]);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("memory get accepts null presentation options and defaults to full YAML", async () => {
  const requests = captureRpcResult(fullMemory);
  const { client, server } = await connect("locked");
  try {
    const withNulls = await client.callTool({
      name: "me_memory_get",
      arguments: { id: fullMemory.id, select: null, format: null },
    });
    const omitted = await client.callTool({
      name: "me_memory_get",
      arguments: { id: fullMemory.id },
    });
    expect(yamlParse(toolText(withNulls))).toEqual(fullMemory);
    expect(yamlParse(toolText(omitted))).toEqual(fullMemory);
    expect(requests).toHaveLength(2);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("memory get-by-path projects locally", async () => {
  const requests = captureRpcResult(fullMemory);
  const { client, server } = await connect("locked");
  try {
    const result = await client.callTool({
      name: "me_memory_get_by_path",
      arguments: {
        path: "/share/design/projection",
        select: ["name", "versionHash"],
        format: "json",
      },
    });
    expect(JSON.parse(toolText(result))).toEqual({
      name: "projection",
      versionHash: fullMemory.versionHash,
    });
    expect(requests).toEqual([
      {
        method: "memory.getByPath",
        params: { path: "/share/design/projection" },
      },
    ]);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("memory search projects rows and keeps both compact JSON format names", async () => {
  const fullResult = {
    results: [{ ...fullMemory, score: 2.5 }],
    total: 1,
    limit: 10,
  };
  const requests = captureRpcResult(fullResult);
  const { client, server } = await connect("locked");
  try {
    const outputs: string[] = [];
    for (const format of ["json", "compact"] as const) {
      const result = await client.callTool({
        name: "me_memory_search",
        arguments: {
          fulltext: "projection",
          select: ["id", "score"],
          format,
        },
      });
      outputs.push(toolText(result));
    }
    expect(outputs[0]).toBe(outputs[1]);
    expect(JSON.parse(outputs[0] ?? "")).toEqual({
      results: [{ id: fullMemory.id, score: 2.5 }],
      total: 1,
      limit: 10,
    });
    expect(requests).toEqual([
      { method: "memory.search", params: { fulltext: "projection" } },
      { method: "memory.search", params: { fulltext: "projection" } },
    ]);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("memory search and export forward every temporal filter", async () => {
  const fullResult = {
    results: [{ ...fullMemory, score: -1 }],
    total: 1,
    limit: 10,
  };
  const requests = captureRpcResult(fullResult);
  const { client, server } = await connect("locked");
  try {
    await client.callTool({
      name: "me_memory_search",
      arguments: {
        temporal: { before: "2026-08-09T12:00:00Z" },
      },
    });
    await client.callTool({
      name: "me_memory_export",
      arguments: {
        temporal: {
          before: "2026-08-09T12:00:00Z",
          after: "2026-08-01T12:00:00Z",
          contains: "2026-08-05T12:00:00Z",
          overlaps: {
            start: "2026-08-04T00:00:00Z",
            end: "2026-08-06T00:00:00Z",
          },
          within: {
            start: "2026-08-01T00:00:00Z",
            end: "2026-08-09T00:00:00Z",
          },
        },
        format: "json",
      },
    });
    expect(requests).toEqual([
      {
        method: "memory.search",
        params: { temporal: { before: "2026-08-09T12:00:00Z" } },
      },
      {
        method: "memory.search",
        params: {
          temporal: {
            before: "2026-08-09T12:00:00Z",
            after: "2026-08-01T12:00:00Z",
            contains: "2026-08-05T12:00:00Z",
            overlaps: {
              start: "2026-08-04T00:00:00Z",
              end: "2026-08-06T00:00:00Z",
            },
            within: {
              start: "2026-08-01T00:00:00Z",
              end: "2026-08-09T00:00:00Z",
            },
          },
          limit: 200,
          orderBy: "asc",
        },
      },
    ]);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("memory search and export forward metaPredicate", async () => {
  const fullResult = {
    results: [{ ...fullMemory, score: -1 }],
    total: 1,
    limit: 10,
  };
  const requests = captureRpcResult(fullResult);
  const { client, server } = await connect("locked");
  try {
    await client.callTool({
      name: "me_memory_search",
      arguments: { metaPredicate: '$.allowList[*] == "tom"' },
    });
    await client.callTool({
      name: "me_memory_export",
      arguments: { metaPredicate: "$.priority >= 3", format: "json" },
    });
    expect(requests).toEqual([
      {
        method: "memory.search",
        params: { metaPredicate: '$.allowList[*] == "tom"' },
      },
      {
        method: "memory.search",
        params: {
          metaPredicate: "$.priority >= 3",
          limit: 200,
          orderBy: "asc",
        },
      },
    ]);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("memory search and export reject empty metaPredicate before RPC", async () => {
  const requests = captureRpcResult({ results: [] });
  const { client, server } = await connect("locked");
  try {
    const search = await client.callTool({
      name: "me_memory_search",
      arguments: { metaPredicate: "   " },
    });
    const exported = await client.callTool({
      name: "me_memory_export",
      arguments: { metaPredicate: "", format: "json" },
    });
    expect(search.isError).toBe(true);
    expect(exported.isError).toBe(true);
    expect(requests).toEqual([]);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("memory read tools reject empty or conflicting selections before RPC", async () => {
  const requests = captureRpcResult(fullMemory);
  const { client, server } = await connect("locked");
  try {
    const empty = await client.callTool({
      name: "me_memory_get",
      arguments: { id: fullMemory.id, select: [] },
    });
    const conflicting = await client.callTool({
      name: "me_memory_get_by_path",
      arguments: {
        path: "/share/design/projection",
        select: ["content:4", "content:4:"],
      },
    });
    expect(empty.isError).toBe(true);
    expect(conflicting.isError).toBe(true);
    expect(requests).toEqual([]);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("multi-space memory tools reject missing space before making a request", async () => {
  const requests = captureFetch();
  const { client, server } = await connect("multi");
  try {
    const missing = await client.callTool({
      name: "me_memory_tree",
      arguments: {},
    });
    expect(missing.isError).toBe(true);
    expect(requests).toEqual([]);

    await client.callTool({
      name: "me_memory_tree",
      arguments: { space: "otherspace01" },
    });
    expect(requests).toEqual([
      {
        method: "memory.tree",
        headers: expect.objectContaining({ "X-Me-Space": "otherspace01" }),
      },
    ]);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("multi-space memory context rejects missing space before making a request", async () => {
  const requests = captureFetch();
  const { client, server } = await connect("multi");
  try {
    const result = await client.callTool({
      name: "me_memory_context",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(requests).toEqual([]);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("multi-space memory tools reject an empty space before making a request", async () => {
  const requests = captureFetch();
  const { client, server } = await connect("multi");
  try {
    const result = await client.callTool({
      name: "me_memory_tree",
      arguments: { space: "" },
    });
    expect(result.isError).toBe(true);
    expect(requests).toEqual([]);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("multi-space memory tools reject a null space before making a request", async () => {
  const requests = captureFetch();
  const { client, server } = await connect("multi");
  try {
    // multiSpaceInput is z.string().min(1) — no .nullable() — so a client that
    // sends {space: null} must fail schema validation before any HTTP call.
    const result = await client.callTool({
      name: "me_memory_tree",
      arguments: { space: null },
    });
    expect(result.isError).toBe(true);
    expect(requests).toEqual([]);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("locked memory tools ignore a smuggled space argument", async () => {
  const requests = captureFetch();
  // Locked-mode schemas omit `space`. The MCP SDK's zod object parser strips
  // unknown keys by default, so a client that still sends {space: "other"}
  // must land at X-Me-Space: <locked>, never at the smuggled slug.
  const { client, server } = await connect("locked", "lockedspace01");
  try {
    await client.callTool({
      name: "me_memory_tree",
      arguments: { space: "attackerspace" },
    });
    const treeRequests = requests.filter(
      (request) => request.method === "memory.tree",
    );
    expect(treeRequests).toHaveLength(1);
    expect(treeRequests[0]?.headers["X-Me-Space"]).toBe("lockedspace01");
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("space discovery preserves the restricted credential's result", async () => {
  const requests = captureFetch([
    { slug: "allowedspace", name: "Allowed Space" },
  ]);
  const { client, server } = await connect("multi");
  try {
    const result = await client.callTool({
      name: "me_space_list",
      arguments: {},
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(
          {
            spaces: [{ slug: "allowedspace", name: "Allowed Space" }],
          },
          null,
          2,
        ),
      },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer token" }),
    );
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("concurrent writes retain their selected spaces", async () => {
  const requests = captureFetch();
  const { client, server } = await connect("multi");
  try {
    await Promise.all([
      client.callTool({
        name: "me_memory_create",
        arguments: {
          content: "first",
          tree: "/share",
          space: "defaultspace",
        },
      }),
      client.callTool({
        name: "me_memory_create",
        arguments: {
          content: "second",
          tree: "/share",
          space: "otherspace01",
        },
      }),
    ]);
    const createRequests = requests.filter(
      (request) => request.method === "memory.create",
    );
    expect(
      createRequests.map((request) => request.headers["X-Me-Space"]).sort(),
    ).toEqual(["defaultspace", "otherspace01"]);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("export and import keep file paths inside the working directory", async () => {
  // realpath: macOS tmpdir is a symlink, and the tools report resolved paths.
  const root = await realpath(await mkdtemp(join(tmpdir(), "me-mcp-fs-")));
  const outside = await realpath(
    await mkdtemp(join(tmpdir(), "me-mcp-outside-")),
  );
  const exportResult = {
    results: [{ ...fullMemory, score: -1 }],
    total: 1,
    limit: 10,
  };
  captureRpcResult(exportResult);
  const { client, server } = await connect("locked", undefined, {
    fsRoot: root,
  });
  try {
    const exportTo = (path: string, overwrite?: boolean) =>
      client.callTool({
        name: "me_memory_export",
        arguments: { format: "json", path, overwrite },
      });

    // Inside the root: relative and absolute spellings both land in root.
    const relative = await exportTo("out/memories.json");
    expect(relative.isError).toBeFalsy();
    expect(JSON.parse(toolText(relative))).toEqual({
      count: 1,
      path: join(root, "out", "memories.json"),
    });
    const written = JSON.parse(
      await readFile(join(root, "out", "memories.json"), "utf-8"),
    ) as Array<{ id: string }>;
    expect(written[0]?.id).toBe(fullMemory.id);

    // An existing file is left alone unless overwrite is requested.
    const clash = await exportTo("out/memories.json");
    expect(clash.isError).toBe(true);
    expect(toolText(clash)).toContain("already exists");
    const replaced = await exportTo("out/memories.json", true);
    expect(replaced.isError).toBeFalsy();

    // Outside the root, by traversal or by absolute path, is refused.
    for (const bad of [
      "../escape.json",
      join(outside, "escape.json"),
      "out/../../escape.json",
    ]) {
      const refused = await exportTo(bad);
      expect(refused.isError).toBe(true);
      expect(toolText(refused)).toContain("inside the working directory");
    }
    expect(existsSync(join(outside, "escape.json"))).toBe(false);

    // Dotfiles and dot-directories are refused even inside the root.
    for (const bad of [".zshenv", ".config/me/config.yaml", "out/.hidden"]) {
      const refused = await exportTo(bad);
      expect(refused.isError).toBe(true);
      expect(toolText(refused)).toContain("dotfile");
    }

    // A symlink inside the root that points outside is refused.
    symlinkSync(outside, join(root, "link"));
    const viaLink = await exportTo("link/escape.json");
    expect(viaLink.isError).toBe(true);
    expect(existsSync(join(outside, "escape.json"))).toBe(false);

    // Import: same confinement, plus only memory-file extensions are read.
    mkdirSync(join(outside, "secrets"));
    writeFileSync(join(outside, "secrets", "key.md"), "---\n---\nsecret");
    writeFileSync(join(root, "notes.txt"), "plain text");
    const importFrom = (path: string, format?: string) =>
      client.callTool({
        name: "me_memory_import",
        arguments: { path, format },
      });
    const outsideImport = await importFrom(join(outside, "secrets", "key.md"));
    expect(outsideImport.isError).toBe(true);
    expect(toolText(outsideImport)).toContain("inside the working directory");
    const txtImport = await importFrom("notes.txt", "md");
    expect(txtImport.isError).toBe(true);
    expect(toolText(txtImport)).toContain("Unsupported file type");
  } finally {
    await Promise.all([client.close(), server.close()]);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
