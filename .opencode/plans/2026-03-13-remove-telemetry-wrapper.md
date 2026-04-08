# Remove Telemetry Wrapper — Use Logfire Directly

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete `packages/telemetry/` and use `@pydantic/logfire-node` directly. Keep only a tiny `span` helper to work around a missing feature in the JS SDK.

**Architecture:** The logfire JS SDK's `span()` doesn't record exceptions or set error status (unlike the Python SDK — this is a gap we'll file upstream). We keep a ~15-line helper for that. Everything else (`configure`, `info`, `debug`, `reportError`) imports directly from logfire-node. Redundant `reportError` calls inside spans are removed — the span helper handles error attribution.

**Tech Stack:** `@pydantic/logfire-node`

---

## Background: Why the span helper exists

Logfire Python's `with logfire.span(...)` automatically records exceptions and sets the span's level to error. The JS SDK's `span()` does not — it only calls `span.end()` via `.finally()`, with no try/catch. This means errors inside spans are invisible in traces.

We file an issue on `pydantic/logfire-js` and keep a small workaround until they fix it. When they do, we delete the helper and use `span()` directly.

## reportError audit

Current `reportError` calls and what happens to each:

| File | Line | Inside span? | Error propagates? | Action |
|---|---|---|---|---|
| `server/index.ts` | 224 | No (setInterval) | N/A | **KEEP** — only logging for this |
| `server/index.ts` | 257 | Yes (`http.request`) | No — caught, returns response | **RESTRUCTURE** — move catch outside span so helper attributes the error to the span. Remove `reportError`. |
| `server/rpc/handler.ts` | 160 | Error from inside `rpc.*` span | Yes — propagates to outer catch | **REMOVE** — span helper records it. Drop `reportError`. |
| `worker/worker.ts` | 80 | No (daemon loop) | N/A | **KEEP** — only logging for this |
| `worker/process.ts` | 60 | Yes (`embedding.batch`) | Yes — re-thrown | **REMOVE** — span helper records it. Remove try/catch/reportError/rethrow, just let it throw. |
| `embedding/generate.ts` | 255 | Yes (`generate_batch`) | No — caught, fallback continues | **KEEP** — error is handled (fallback), callback returns normally. Span helper never sees it. Change to `warning()` since it's recoverable. |

---

## File Map

**Delete:**
- `packages/telemetry/` (entire directory)

**Create:**
- `packages/server/telemetry.ts` — tiny span helper (~15 lines). Lives in server since that's where `configure()` is called; other packages import from logfire-node directly for `info`/`debug`/`reportError`/etc.

**Modify:**
- `packages/server/package.json` — replace `@memory-engine/telemetry` with `@pydantic/logfire-node`
- `packages/server/index.ts` — switch imports, inline configure, restructure HTTP span
- `packages/server/middleware/authenticate.ts` — switch import
- `packages/server/rpc/handler.ts` — switch imports, convert span, remove `reportError`
- `packages/server/handlers/health.ts` — switch import
- `packages/worker/package.json` — replace dep
- `packages/worker/worker.ts` — switch imports
- `packages/worker/process.ts` — switch imports, convert span, remove redundant reportError
- `packages/engine/package.json` — replace dep
- `packages/engine/ops/_tx.ts` — switch imports, convert span
- `packages/embedding/package.json` — replace dep
- `packages/embedding/generate.ts` — switch imports, convert spans, change batch reportError to warning
- `packages/accounts/package.json` — replace dep
- `packages/accounts/ops/_tx.ts` — switch imports, convert span

---

### Task 0: File upstream issue

- [ ] **Step 1: File issue on pydantic/logfire-js**

Title: `span() should record exceptions like the Python SDK does`

Body: The Python SDK's `logfire.span` context manager automatically calls `recordException` and sets `setStatus(ERROR)` when the callback throws. The JS SDK's `span()` function (`packages/logfire-api/src/index.ts`) does not — it only calls `span.end()` via `.finally()`. This means errors inside spans aren't attributed to the span in traces.

```bash
gh issue create --repo pydantic/logfire-js \
  --title "span() should record exceptions like the Python SDK does" \
  --body "The Python SDK's \`logfire.span\` context manager automatically calls \`recordException\` and sets the span status to ERROR when the callback raises. The JS SDK's \`span()\` function does not — it only calls \`span.end()\` via \`.finally()\`, with no try/catch.

This means errors thrown inside \`span()\` callbacks aren't attributed to the span in traces. Users have to manually wrap callbacks in try/catch and call \`span.recordException()\` themselves to get proper error attribution.

**Expected behavior (matching Python SDK):** If the callback throws (sync) or rejects (async), the span should automatically have the exception recorded and its status set to ERROR before re-throwing.

**Actual behavior:** The span ends normally. The error propagates but the span carries no error information.

Relevant source: \`packages/logfire-api/src/index.ts\`, the \`span()\` function."
```

- [ ] **Step 2: Commit**

No file changes — just the issue.

---

### Task 1: Create span helper and update server entry point

**Files:**
- Create: `packages/server/telemetry.ts`
- Modify: `packages/server/package.json`
- Modify: `packages/server/index.ts`

- [ ] **Step 1: Update server package.json**

In `packages/server/package.json`, replace:
```json
"@memory-engine/telemetry": "workspace:*",
```
with:
```json
"@pydantic/logfire-node": "^0.13.0",
```

- [ ] **Step 2: Create packages/server/telemetry.ts**

This is the only piece of the old wrapper that earns its keep — error recording on spans. It goes away when logfire-js fixes the upstream issue.

```typescript
// Workaround: logfire-js span() doesn't record exceptions like the Python SDK.
// See: https://github.com/pydantic/logfire-js/issues/XXX
// Delete this file when the upstream fix ships.

import { type Span, SpanStatusCode } from "@opentelemetry/api";
import { span as logfireSpan } from "@pydantic/logfire-node";

export function span<R>(
  name: string,
  options: {
    attributes?: Record<string, unknown>;
    callback: (span: Span) => R;
  },
): R {
  return logfireSpan(name, {
    ...options,
    callback: (s: Span) => {
      try {
        const result = options.callback(s);
        if (result instanceof Promise) {
          return result.catch((err: unknown) => {
            if (err instanceof Error) {
              s.recordException(err);
              s.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            }
            throw err;
          }) as R;
        }
        return result;
      } catch (err) {
        if (err instanceof Error) {
          s.recordException(err);
          s.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        }
        throw err;
      }
    },
  });
}
```

- [ ] **Step 3: Update server/index.ts imports and configure**

Replace:
```typescript
import {
  configure,
  info,
  reportError,
  withSpan,
} from "@memory-engine/telemetry";
```

With:
```typescript
import { configure, info, reportError } from "@pydantic/logfire-node";
import { span } from "./telemetry";
```

Replace:
```typescript
// Initialize telemetry before starting server
await configure();
```

With:
```typescript
// Initialize telemetry before starting server
configure({
  sendToLogfire: "if-token-present",
  serviceName: "memory-engine",
  serviceVersion: "0.1.0",
  scrubbing: {
    extraPatterns: [
      "content",    // Memory content — potentially sensitive user data
      "embedding",  // Vector embeddings — large, not useful in traces
      "access_token",
      "refresh_token",
    ],
  },
});
```

Note: `configure()` is synchronous in logfire-node, drop the `await`.

- [ ] **Step 4: Restructure HTTP request handler — catch outside span**

Currently the error is caught INSIDE the span callback, so the span never sees it. Move the catch outside so the span helper records it.

Replace:
```typescript
    return withSpan(
      "http.request",
      {
        "http.method": method,
        "http.url": request.url,
        "http.path": path,
      },
      async () => {
        try {
          // Check size limit
          const sizeError = checkSizeLimit(request);
          if (sizeError) {
            return sizeError;
          }

          // Route and handle request
          return await router.handleRequest(request);
        } catch (error) {
          reportError("Request failed", error as Error, {
            "http.method": method,
            "http.path": path,
          });
          return internalError();
        }
      },
    );
```

With:
```typescript
    try {
      return await span("http.request", {
        attributes: {
          "http.method": method,
          "http.url": request.url,
          "http.path": path,
        },
        callback: async () => {
          // Check size limit
          const sizeError = checkSizeLimit(request);
          if (sizeError) {
            return sizeError;
          }

          // Route and handle request
          return await router.handleRequest(request);
        },
      });
    } catch {
      // Error already recorded on http.request span by the helper
      return internalError();
    }
```

Remove `reportError` import if no longer used in this file (check: the `setInterval` cleanup at line 224 still uses it — keep the import).

- [ ] **Step 5: Commit**

```bash
git add packages/server/telemetry.ts packages/server/index.ts packages/server/package.json
git commit -m "refactor(server): replace telemetry wrapper with direct logfire-node + span helper"
```

---

### Task 2: Update server middleware and handlers

**Files:**
- Modify: `packages/server/middleware/authenticate.ts`
- Modify: `packages/server/rpc/handler.ts`
- Modify: `packages/server/handlers/health.ts`

- [ ] **Step 1: Update authenticate.ts import**

Replace:
```typescript
import { debug } from "@memory-engine/telemetry";
```
With:
```typescript
import { debug } from "@pydantic/logfire-node";
```

- [ ] **Step 2: Update handler.ts — switch imports, convert span, remove redundant reportError**

Replace:
```typescript
import { reportError, withSpan } from "@memory-engine/telemetry";
```
With:
```typescript
import { span } from "../telemetry";
```

Replace the span call:
```typescript
    const result = await withSpan(
      `rpc.${rpcRequest.method}`,
      {
        "rpc.method": rpcRequest.method,
      },
      async () => {
        const handlerContext: HandlerContext = { request, ...context };
        return method.handler(paramsResult.data, handlerContext);
      },
    );
```
With:
```typescript
    const result = await span(`rpc.${rpcRequest.method}`, {
      attributes: {
        "rpc.method": rpcRequest.method,
      },
      callback: async () => {
        const handlerContext: HandlerContext = { request, ...context };
        return method.handler(paramsResult.data, handlerContext);
      },
    });
```

Remove the redundant `reportError` call in the catch block. The span helper already recorded the error on the `rpc.*` span. Keep the catch for returning the error response:

Replace:
```typescript
    // Log unexpected errors with full context
    reportError("RPC handler error", error as Error, {
      "rpc.request_id": requestId,
    });

    return json(internalError(requestId));
```
With:
```typescript
    // Error already recorded on rpc.* span by the span helper
    return json(internalError(requestId));
```

- [ ] **Step 3: Update health.ts import**

Replace:
```typescript
import { info } from "@memory-engine/telemetry";
```
With:
```typescript
import { info } from "@pydantic/logfire-node";
```

- [ ] **Step 4: Commit**

```bash
git add packages/server/middleware/authenticate.ts packages/server/rpc/handler.ts packages/server/handlers/health.ts
git commit -m "refactor(server): switch middleware and handlers to direct logfire-node imports"
```

---

### Task 3: Update worker package

**Files:**
- Modify: `packages/worker/package.json`
- Modify: `packages/worker/worker.ts`
- Modify: `packages/worker/process.ts`

- [ ] **Step 1: Update worker package.json**

Replace:
```json
"@memory-engine/telemetry": "workspace:*"
```
With:
```json
"@pydantic/logfire-node": "^0.13.0"
```

- [ ] **Step 2: Update worker.ts import**

Replace:
```typescript
import { info, reportError } from "@memory-engine/telemetry";
```
With:
```typescript
import { info, reportError } from "@pydantic/logfire-node";
```

No other changes — these are outside any span, correctly used.

- [ ] **Step 3: Update process.ts — switch imports, remove redundant reportError**

Replace:
```typescript
import { info, reportError, withSpan } from "@memory-engine/telemetry";
```
With:
```typescript
import { info } from "@pydantic/logfire-node";
import { span } from "@memory-engine/server/telemetry";
```

Note: check if the server package exports the telemetry module. If cross-package import is awkward, duplicate the span helper into this package or put it in a shared location. The simplest approach may be to inline the helper into worker as well (it's only ~15 lines). See Step 3b for alternative.

**Step 3b (alternative): If cross-package import doesn't work**, just copy the span helper to `packages/worker/telemetry.ts` and import locally:

```typescript
import { span } from "./telemetry";
```

Replace the `withSpan` call AND remove the redundant try/catch/reportError/rethrow:

Current code:
```typescript
  return withSpan(
    "embedding.batch",
    {
      "worker.schema": schema,
      "batch.size": claimed.length,
      "batch.memoryIds": claimed.map((r) => r.memory_id),
    },
    async () => {
      const rows = claimed.map((r) => ({
        id: r.memory_id,
        content: r.content,
      }));
      let embedResults: Awaited<ReturnType<typeof generateEmbeddings>>;

      try {
        embedResults = await generateEmbeddings(rows, config.embedding);
      } catch (error) {
        reportError("Embedding generation failed", error as Error, {
          "worker.schema": schema,
          "batch.size": claimed.length,
          "embedding.provider": config.embedding.provider,
          "embedding.model": config.embedding.model,
        });
        throw error;
      }
```

Replace with (remove the try/catch/reportError — the span helper handles error attribution):
```typescript
  return span("embedding.batch", {
    attributes: {
      "worker.schema": schema,
      "batch.size": claimed.length,
      "batch.memoryIds": claimed.map((r) => r.memory_id),
    },
    callback: async () => {
      const rows = claimed.map((r) => ({
        id: r.memory_id,
        content: r.content,
      }));

      const embedResults = await generateEmbeddings(rows, config.embedding);
```

The rest of the function body stays the same. The `let` becomes `const` since there's no separate assignment in a try block.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/
git commit -m "refactor(worker): switch to direct logfire-node, remove redundant reportError"
```

---

### Task 4: Update engine package

**Files:**
- Modify: `packages/engine/package.json`
- Modify: `packages/engine/ops/_tx.ts`

- [ ] **Step 1: Update engine package.json**

Replace `"@memory-engine/telemetry": "workspace:*"` with `"@pydantic/logfire-node": "^0.13.0"`.

- [ ] **Step 2: Update _tx.ts**

The span helper needs to be available here. Same approach as worker: either import cross-package or copy the ~15-line helper to `packages/engine/telemetry.ts`.

Replace:
```typescript
import { withSpan } from "@memory-engine/telemetry";
```
With:
```typescript
import { span } from "./telemetry";
```

Convert `withSpan(name, attrs, fn)` to `span(name, { attributes: attrs, callback: fn })`.

- [ ] **Step 3: Commit**

```bash
git add packages/engine/
git commit -m "refactor(engine): switch to direct logfire-node imports"
```

---

### Task 5: Update embedding package

**Files:**
- Modify: `packages/embedding/package.json`
- Modify: `packages/embedding/generate.ts`

- [ ] **Step 1: Update embedding package.json**

Replace `"@memory-engine/telemetry": "workspace:*"` with `"@pydantic/logfire-node": "^0.13.0"`.

- [ ] **Step 2: Update generate.ts**

Replace:
```typescript
import { reportError, withSpan } from "@memory-engine/telemetry";
```
With:
```typescript
import { warning } from "@pydantic/logfire-node";
import { span } from "./telemetry";
```

Copy span helper to `packages/embedding/telemetry.ts` (same as other packages).

Convert all 4 `withSpan` calls to `span` using: `withSpan(name, attrs, fn)` → `span(name, { attributes: attrs, callback: fn })`.

Change the batch fallback `reportError` to `warning` (it's a recoverable situation, not an error that should create a separate error span):

Replace:
```typescript
        reportError(
          "Batch embedding failed, falling back to individual requests",
          err,
          {
            provider: config.provider,
            model: config.model,
            batch_size: rows.length,
            fallback: "individual",
          },
        );
```
With:
```typescript
        warning(
          "Batch embedding failed, falling back to individual requests",
          {
            provider: config.provider,
            model: config.model,
            batch_size: rows.length,
            fallback: "individual",
            error: err.message,
          },
        );
```

- [ ] **Step 3: Commit**

```bash
git add packages/embedding/
git commit -m "refactor(embedding): switch to direct logfire-node, batch fallback uses warning"
```

---

### Task 6: Update accounts package

**Files:**
- Modify: `packages/accounts/package.json`
- Modify: `packages/accounts/ops/_tx.ts`

- [ ] **Step 1: Update accounts package.json**

Replace `"@memory-engine/telemetry": "workspace:*"` with `"@pydantic/logfire-node": "^0.13.0"`.

- [ ] **Step 2: Update _tx.ts**

Copy span helper to `packages/accounts/telemetry.ts`.

Replace:
```typescript
import { withSpan } from "@memory-engine/telemetry";
```
With:
```typescript
import { span } from "./telemetry";
```

Convert the `withSpan` call.

- [ ] **Step 3: Commit**

```bash
git add packages/accounts/
git commit -m "refactor(accounts): switch to direct logfire-node imports"
```

---

### Task 7: Delete telemetry package and install

- [ ] **Step 1: Delete the telemetry package**

```bash
rm -rf packages/telemetry
```

- [ ] **Step 2: Run bun install**

```bash
bun install
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: delete @memory-engine/telemetry wrapper package"
```

---

### Task 8: Verify build and tests

- [ ] **Step 1: Run typecheck**

```bash
bun run typecheck
```

Expected: No type errors.

- [ ] **Step 2: Run tests**

```bash
bun test packages
```

Expected: All tests pass.

- [ ] **Step 3: Run lint/format**

```bash
bun run check
```

Expected: Clean.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve type/lint issues from telemetry migration"
```
