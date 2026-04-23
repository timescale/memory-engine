# `me serve` — Implementation Plan

## Progress

Running log of completed work. Each item links to the step in §12 Roadmap.

- [x] **Step 1 — Scaffold `packages/web`.** Vite 7 + React 19 + TypeScript + Tailwind v4. `tsconfig.{app,node}.json` split. Root `tsconfig.json` excludes `packages/web` so it uses its own browser-oriented config. `vite dev` port 5173 with `/rpc` and `/healthz` proxied to `localhost:3000`. Placeholder App component renders a centered "Memory Engine" heading. Verified: `./bun --cwd` wasn't used — `cd packages/web && ../../bun run build` produces `dist/index.html` + assets; `tsc -p tsconfig.app.json --noEmit` clean; `./bun run check` at root clean (223 files, 639 tests).
- [x] **Step 2 — Scaffold `me serve` command.** New `packages/cli/commands/serve.ts` + `packages/cli/serve/http-server.ts`. Flags: `--port`, `--host`, `--no-open`. Port discovery auto-increments from 3000 (up to 20 attempts) when `--port` is unspecified; explicit `--port` is strict. Credentials resolved via `resolveCredentials(--server)` + `requireEngine` (fails fast when no API key). Bun.serve binds, handles `/healthz` (JSON), `/rpc` (501 stub, real in step 3), and everything else (placeholder HTML). Auto-opens the browser unless `--no-open`. SIGINT/SIGTERM cleanly stop the server. Smoke-tested: `ME_API_KEY=dummy me serve --no-open --port 3137` — `curl /healthz` returns `{"ok":true}`, `curl /` returns the placeholder page, `curl -X POST /rpc` returns 501.
- [x] **Step 3 — Wire the `/rpc` proxy.** `POST /rpc` forwards body byte-for-byte to `{server}/api/v1/engine/rpc`, injects `Authorization: Bearer <apiKey>`, streams response back verbatim (preserves upstream status + Content-Type). Upstream failures surface as JSON-RPC-shaped `{ jsonrpc: "2.0", id: null, error: { code: -32000, message } }` with HTTP 502. Non-POST returns 405. New `packages/cli/serve/http-server.test.ts` covers healthz, SPA fallback, 405, body/headers/status pass-through, auth header injection, and upstream-unreachable 502 (8 tests). Fixed cosmetic: `Active engine: undefined` only prints when a slug is present.
- [x] **Step 4 — Embed static assets into the binary.** New `scripts/bundle-web-assets.ts` walks `packages/web/dist/`, base64-encodes each file, and emits `packages/cli/serve/web-assets.generated.ts` (a `Map<path, {contentType, data: Uint8Array}>`). Sourcemaps skipped by default (ME_EMBED_SOURCEMAPS=1 to include). New `packages/cli/serve/web-assets.ts` wraps the generated map with SPA-fallback semantics: `/` → `/index.html`; path-with-extension miss → 404; extensionless miss → index.html; empty map → friendly placeholder page pointing to the dev server. Hashed `/assets/*` get `Cache-Control: public, max-age=31536000, immutable`; `index.html` gets `no-cache`. HTTP server now delegates all non-`/rpc`/`/healthz` GET/HEAD to the resolver; other methods return 405. `packages/cli/package.json` gains `build:web` (vite build + bundle-web-assets). Root `.gitignore` now ignores `*.generated.ts`. Smoke-tested: `/` serves index.html, `/assets/index-*.js` returns 200 with immutable cache, `/does-not-exist.txt` returns 404, `/some/spa/route` returns HTML.
- [x] **Step 5 — RPC client + TanStack Query.** Added `@tanstack/react-query` + `zustand` to `packages/web`. New `src/api/client.ts` with a `rpc<T>(method, params)` helper (JSON-RPC 2.0 envelope, structured `RpcError`). New `src/api/types.ts` with minimal inline types (`Memory`, `MemoryWithScore`, `MemorySearchResult`, etc.) — kept decoupled from `@memory.build/protocol` for now (YAGNI; promote to a workspace dep if duplication grows). New `src/api/queries.ts` exposes `useMemories`, `useMemory`, `useUpdateMemory`, `useDeleteMemory`, `useDeleteTree`; `normalizeSearchParams` inserts the `tree: "*"` wildcard when no filter criteria are supplied and clamps to `limit: 1000`. `main.tsx` wraps the app in a `QueryClientProvider` with sensible defaults (5s stale, no retry, no refetch-on-focus). `app.tsx` renders a list-all sanity check pane. Vite bundle now 230 KB JS / 72 KB gzipped.
- [x] **Step 6 — Tree build + render.** New `src/lib/tree-build.ts` with `buildTree(memories)` → nested `PathNode` (synthetic `.` root, ltree segments as intermediate paths, memories as leaves with first-non-empty-line titles trimmed to 60 chars). Sorted paths-before-memories, alpha within each kind. `collectPaths` enumerates live paths so expansion state can be pruned on filter changes. New `src/store/selection.ts` (zustand) tracks `selectedId` + `expandedPaths` Set with actions (`select`, `toggleExpanded`, `setExpanded`, `pruneExpanded`) — root always stays expanded after prune. New `TreeView` + `TreeNodeRow` components render with Tailwind classes, indent by depth, selected row highlighted sky-100. App now renders a two-pane layout (tree left / selected memory JSON right). 8 tree-build unit tests. Biome a11y rules satisfied by using `<div role="treeitem">` + tabIndex instead of `<li>`.
- [x] **Step 7 — Markdown viewer + metadata panel.** Installed `react-markdown`, `remark-gfm`, `rehype-highlight`, `highlight.js`. New `MarkdownViewer` (GFM tables / task lists / strikethrough + code-block syntax highlighting via github.css). New `MetadataPanel` showing read-only fields (id, hasEmbedding, createdAt, updatedAt, createdBy). App right pane now renders a card layout: tree breadcrumb → rendered markdown → metadata. Added lightweight `.prose` CSS directly in `styles.css` (no typography plugin dependency). Bundle grew to 571 KB (175 KB gzipped) — mostly highlight.js languages. Slim down in step 12 polish if needed.
- [x] **Step 8 — Simple search bar + URL sync.** New `src/store/filter.ts` holds the full filter shape (simple string + advanced field-by-field) and a `selectSearchParams` derivation that maps to `MemorySearchParams`. Simple mode populates both `semantic` and `fulltext` with the query. New `src/lib/url-state.ts` + `useUrlSync` hook — hydrate from URL on mount, `replaceState` on every change, rehydrate on `popstate`. `useDebounced(250ms)` throttles keystrokes before the RPC. `SimpleSearchBar` component with a `[Simple | Advanced]` toggle (advanced panel itself wired in step 9) and an always-visible Clear button. 5 new URL round-trip tests. Shareable URLs like `?q=typescript&selected=<uuid>` now restore the exact view.
- [x] **Step 9 — Advanced search panel.** New `AdvancedSearchPanel` exposes every `memory.search` param: semantic, fulltext, grep, tree, meta (JSON textarea with live validation — red border + inline error when invalid), temporal (mode selector + start/end datetime-local pickers, end disabled in `contains` mode), limit, candidateLimit, weights.semantic / weights.fulltext, orderBy. Grid layout, responsive to narrow widths. Rendered directly below the mode toggle when advanced mode is active. Biome a11y rule on `<label>` satisfied by rendering multi-input rows as `<div>` with visual label spans.
- [x] **Step 10 — Monaco editor + frontmatter + dirty tracking.** Installed `@monaco-editor/react`, `monaco-editor`, `js-yaml`. New `src/lib/frontmatter.ts` parses/serializes YAML frontmatter + body (object, array, and string temporal forms all accepted on input; object form emitted on output). 9 new frontmatter unit tests. New `MonacoMarkdownEditor` bundles Monaco locally (no CDN) with `?worker` imports for offline use; lazy-loaded via `React.lazy` so the initial bundle stays at 631 KB (194 KB gz) and Monaco's 3.3 MB chunk only loads when edit mode is first entered. New `EditorPane` handles the view/edit toggle, dirty tracking, Save (via `useUpdateMemory` — sends `{content, tree, meta, temporal}` diff), parse-error banner, unsaved indicator pill, and a Delete button (dialog wired in step 11). `useEditor` zustand store exposes a global `dirty` flag; `confirmDiscardChangesIfDirty()` is called from the tree row onClick, and a `beforeunload` listener covers tab close / refresh. Build grew to 93 embedded assets (~6.9 MB base64) — initial UI remains snappy; Monaco workers are split into their own chunks.
- [x] **Step 11 — Delete flows + context menus.** New `useUi` zustand store for context-menu coordinates + active dialog targets. New `ContextMenu` floats at the cursor (closes on outside click or Escape); tree path rows show `Delete subtree…`, memory leaves show `Delete memory…`. The synthetic root is skipped. New shared `Dialog` primitive (backdrop button for a11y-safe dismissal, Escape handler, focus management). `DeleteMemoryDialog` confirms + calls `memory.delete` and clears selection when the deleted memory was selected. `DeleteTreeDialog` first fetches the exact count via `memory.deleteTree` with `dryRun: true`, then confirms with "Delete N memories" destructive button. `EditorPane` Delete button now opens the single-memory dialog via `askDeleteMemory`. Invalidations refresh the tree after a successful delete. Biome a11y / complexity warnings cleaned up (optional-chain, fragment simplification, clickable-backdrop pattern).
- [x] **Step 12 — Auto-open browser + polish.** Auto-open already lands in step 2; browser opens via `open` / `xdg-open` / `start` unless `--no-open`. Added a lightweight toast system (`pushToast(message, kind)` + `<ToastStack />`) wired to Save success/failure, single-memory delete, and subtree delete (includes the exact count). No heavy dependency — one zustand store, one component, ~90 lines.
- [x] **Step 13 — Docs + final `./bun run check`.** New `docs/cli/me-serve.md` documenting usage, flags, UI layout, security posture, and examples. `docs/getting-started.md` gained a "Browse in the web UI" section linking to the serve reference. `mkdocs.yml` nav updated (me serve between me mcp and me user). Final `./bun run check` clean: 669 tests, 0 failures, no lint warnings. End-to-end smoke test: `me serve --no-open --port 3157` with dummy credentials serves the embedded React bundle (index.html + hashed JS asset at 638 KB with correct Content-Type + length).

## Shipping summary

All thirteen roadmap steps are done. The `me serve` command launches a local web UI with tree navigation, hybrid + advanced search, Markdown viewer, Monaco-backed editor with YAML frontmatter, save with dirty tracking, single-memory and subtree delete flows, a context menu, toast notifications, and URL-shareable filter + selection state. The backend is a Bun HTTP server that serves the embedded Vite build and proxies `/rpc` to the active engine with the stored API key injected server-side.

Known follow-ups intentionally deferred (not in scope for MVP):

- Creating new memories from the UI (plan §8 explicitly out of scope).
- Real-time sync / collision detection across tabs (plan §24).
- Keyboard navigation in the tree (nice-to-have from §6).
- Bundle trimming — Monaco is lazy-loaded into its own chunk, but the full language set is still embedded; swapping to CodeMirror 6 or a narrower Monaco build would shave several MB from the binary.

---

## 1. Overview

`me serve` launches a local HTTP server that serves:
- A **static React app** (Vite-built, embedded in the `me` binary) for viewing/managing memories.
- A **thin JSON-RPC proxy** that forwards calls to the configured remote engine, injecting the stored API key.

The browser speaks only to `localhost`; it never sees the API key or session token.

---

## 2. Package layout

New package: **`packages/web/`** — the React app (Vite-built).

```
packages/web/
  package.json          # devDependencies: vite, react, tailwind, etc.
  vite.config.ts        # build → dist/, dev proxy → http://localhost:3000
  index.html
  tsconfig.json
  tailwind.config.ts
  src/
    main.tsx
    app.tsx
    api/
      client.ts         # thin fetch wrapper around /rpc
      queries.ts        # TanStack Query hooks: useMemories, useMemory, useUpdate, etc.
    store/
      filter.ts         # zustand: current search params, advanced-mode toggle
      selection.ts      # zustand: selected memory id, expanded tree nodes, dirty state
    components/
      layout/           # AppShell, SplitPane
      search/           # SimpleSearchBar, AdvancedSearchPanel, FilterChips
      tree/             # TreeView, TreeNode, ContextMenu
      viewer/           # MarkdownViewer, MetadataPanel, EditorToggle
      editor/           # MonacoMarkdownEditor (frontmatter + body)
      dialogs/          # DeleteMemoryDialog, DeleteTreeDialog
    lib/
      frontmatter.ts    # parse/stringify YAML frontmatter + markdown body
      tree-build.ts     # [{id,tree,content,…}] → nested tree nodes
      url-state.ts      # sync filter state ↔ URL params
    styles.css          # tailwind entry
  dist/                 # build output, imported by CLI
```

New command file: **`packages/cli/commands/serve.ts`**.

New util: **`packages/cli/web-assets.ts`** — returns the embedded `dist/` files.

---

## 3. Backend (`me serve` command)

### CLI surface

```
me serve [--port <port>] [--host <host>] [--no-open]
```

- Respects the global `--server` flag and `ME_SERVER` (same as every other command).
- Resolves credentials using the existing `credentials.ts` helpers: session token + active engine + engine API key. If no active engine, error out with the same message as other commands.
- `--port` default: `3000`. If unavailable, probe upward (`3001`, `3002`, …) until one binds. Explicit `--port` fails hard if unavailable.
- `--host` default: `127.0.0.1` (localhost-only; no LAN exposure).
- `--no-open`: suppress auto-open. Otherwise, open the browser after bind.

### HTTP server

Bun's built-in `Bun.serve`, single file, no framework:

| Route | Behavior |
|---|---|
| `GET /` and any unknown path | Serve embedded `index.html` (SPA fallback) |
| `GET /assets/*` | Serve embedded Vite build artifacts with correct `Content-Type` + long cache headers |
| `POST /rpc` | Proxy: forward body to `{server}/api/v1/engine/rpc` with `Authorization: Bearer <apiKey>`, stream response back verbatim |
| `GET /healthz` | `{ ok: true }` (for the `--wait` behavior in launch logic) |

The proxy is deliberately dumb — it forwards the request body byte-for-byte and doesn't validate RPC methods. This means the UI automatically picks up any new `memory.*` method without backend changes.

### Binary embedding

Bun's `--compile` supports file embedding via `import` of assets. We'll:
- Run `bun run build` in `packages/web/` before `cli build`, producing `packages/web/dist/`.
- In `packages/cli/web-assets.ts`, use an `import.meta.glob`-style approach (or Bun's `embed:` loader) to pull every file under `packages/web/dist/` into a `Map<string, { contentType: string; body: Uint8Array }>`.
- The CLI `build` script gets a pre-step: `bun --cwd ../web run build`.

Root-level script update: `./bun run build` should build the web app first, then the CLI.

---

## 4. Frontend architecture

### Stack

- **React 19** + **TypeScript**, bundled by **Vite**.
- **TailwindCSS v4** (just-in-time, via `@tailwindcss/vite`).
- **zustand** for global UI state (filter, selection, dirty-tracking, URL sync).
- **TanStack Query** for all RPC calls. Query keys are derived from the filter state so caching and refetch-on-filter-change fall out naturally.
- **Monaco editor** via `@monaco-editor/react`, loader pointed at a bundled copy (not CDN) so the app works offline.
- **react-markdown** + `remark-gfm` + `rehype-highlight` for the rendered view.
- **js-yaml** for frontmatter parsing/serialization (matches the `md` export format in `docs/formats.md`).

### App shell (single page)

```
┌───────────────────────────────────────────────────────────────┐
│  SearchBar  [Simple ▸ Advanced]  [Clear]                      │ ← top
├────────────────────┬──────────────────────────────────────────┤
│                    │  [← back]   id: …   [View|Edit] [Delete] │
│                    ├──────────────────────────────────────────┤
│  TreeView          │                                          │
│   . (synthetic)    │   Markdown viewer / Monaco editor        │
│     ├─ work        │                                          │
│     │   └─ 📄 …    │                                          │
│     └─ personal    │                                          │
│                    │                                          │
│                    ├──────────────────────────────────────────┤
│                    │  Read-only: id, tree, hasEmbedding, …   │
└────────────────────┴──────────────────────────────────────────┘
```

Resizable split (CSS `resize` or a small custom splitter).

---

## 5. Data fetching

One primary query: **"all memories matching current filter"**.

```ts
const { data, isLoading } = useQuery({
  queryKey: ["memories", filterState],
  queryFn: () => rpc("memory.search", { ...filterState, limit: 1000 }),
});
```

- **No pagination** per spec. Pass `limit: 1000` (the protocol max). If a user hits the ceiling, surface a banner "Showing first 1000 — refine your filter" — this costs almost nothing and is better than silently truncating.
- **Empty filter = list all**: unfiltered load uses `tree: "*"` (the treeFilterSchema wildcard that matches everything). The advanced panel's "tree" field, when empty, omits the key entirely; the simple bar triggers a hybrid search when non-empty and a list-all when empty.
- **Selected memory detail**: `memory.search` already returns full content; the UI uses the search-result row directly and only calls `memory.get` if the user lands on a detail via URL without a populated list (shareable link).
- **Invalidation**: after `update` / `delete` / `deleteTree`, invalidate `["memories"]` and (for update) `["memory", id]`. UI shows a spinner and refetches — no optimistic updates, per spec.

---

## 6. Tree view

### Node model

Derived client-side from the flat search result:

```ts
type TreeNode =
  | { kind: "path"; path: string; label: string; children: TreeNode[] }
  | { kind: "memory"; id: string; title: string; tree: string };
```

- Paths are ltree segments; memories are leaves under their path.
- Synthetic root labeled `.` covers memories with an empty tree. Always rendered as the top-level node and expanded by default; all other path nodes collapsed by default.
- Memory leaf **title**: first non-empty line of `content`, trimmed to ~60 chars. Falls back to the id suffix if content is empty.
- **No counts** per spec.

### Filtering behavior

- Because the filter drives the query, the tree *only* contains matching memories. Intermediate path nodes appear iff they have ≥1 matching descendant. No extra "show matches only" toggle needed.
- Expansion state is preserved across filter changes when a path is still present; otherwise it drops naturally.

### Interaction

- **Click path**: expand/collapse.
- **Click memory leaf**: select it (right pane updates; URL updates).
- **Right-click path node**: context menu → **Delete subtree…** (opens `DeleteTreeDialog`).
- **Right-click memory leaf**: context menu → **Delete memory…** (opens `DeleteMemoryDialog`).
- Keyboard: arrow keys navigate, Enter selects, Delete opens the appropriate dialog. Nice-to-have; not blocking MVP.

---

## 7. Search & filter UX

### Simple mode

A single text input. Debounced (250 ms). Submitting populates both `semantic` and `fulltext` with the same string, leaving weights at defaults → hybrid search.

### Advanced mode

A panel exposing every `memory.search` parameter:

| Field | UI |
|---|---|
| `semantic` | text input |
| `fulltext` | text input |
| `grep` | text input |
| `tree` | text input (supports the same wildcard syntax as the CLI) |
| `meta` | JSON textarea with live validation (red border on parse error, submit disabled) |
| `temporal` | mode selector (`contains` / `overlaps` / `within`) + date-time picker(s). `overlaps`/`within` show two pickers; `contains` shows one |
| `limit` | number input, default 1000 |
| `candidateLimit` | number input |
| `weights.semantic` / `weights.fulltext` | two number inputs (0–1) |
| `orderBy` | `asc` / `desc` dropdown |

Mode toggle is a button pair: `[Simple] [Advanced]`. Switching to simple discards advanced-only fields. Switching to advanced pre-fills `semantic` + `fulltext` with the simple query.

### Clear button

Always visible in the top bar. Clears all fields and resets URL.

### URL state

zustand middleware syncs filter state to URL search params:
- `q` (simple query), `semantic`, `fulltext`, `grep`, `tree`, `meta` (stringified JSON), `temporal_mode`, `temporal_start`, `temporal_end`, `limit`, `candidate_limit`, `weights_semantic`, `weights_fulltext`, `order_by`, `mode` (`simple`|`advanced`), and `selected` (memory id).
- On load, hydrate state from URL. Sharing a URL restores the exact view.

---

## 8. Viewer / Editor

### Selected memory layout

Top bar of the right pane:
- Breadcrumb of tree path.
- View/Edit toggle.
- **Save** button (disabled unless dirty).
- **Delete** button.

Below: either the rendered markdown (view mode) or the Monaco editor (edit mode).

Bottom: **read-only metadata panel** showing `id`, `hasEmbedding`, and (when present) server-assigned timestamps. Not inside the editor.

### Frontmatter-in-editor

Matches the `md` import/export schema from `docs/formats.md`:

```markdown
---
tree: work.projects.me2
meta:
  source: meeting
  priority: high
temporal:
  start: 2026-04-01T00:00:00Z
  end: 2026-04-30T00:00:00Z
---
<body markdown here>
```

- Omit a key to clear the corresponding field (server receives `null`).
- `id` is **not** in the frontmatter — it's a read-only field rendered outside the editor.
- Parse errors (invalid YAML) disable Save and show an inline error above the editor.

### Dirty tracking

- On mount, snapshot the serialized "frontmatter + body" string.
- On change, compare to snapshot. Save button enabled iff different.
- **beforeunload** handler + in-app navigation guard when dirty. A dialog confirms discard on tree-click / back navigation.
- Save calls `memory.update` with the diff fields; on success, snapshot becomes the new state, invalidate the queries, toast "Saved".

### Monaco config

- `language: "markdown"`, `wordWrap: "on"`, line numbers on, minimap off, theme matches the app (light by default; we can add dark later).
- `automaticLayout: true` so the split-pane resize works.

---

## 9. Delete flows

### Single memory

`DeleteMemoryDialog`:
- Title: "Delete this memory?"
- Shows the title line + id.
- Buttons: **Cancel** / **Delete**.
- On confirm → `memory.delete`, close dialog, clear selection, refetch.

### Tree subtree

`DeleteTreeDialog`:
- On open, call `memory.deleteTree` with `dryRun: true` to get the count.
- Renders: "This will delete **N memories** under `<path>`."
- Buttons: **Cancel** / **Delete N memories** (destructive style).
- On confirm → `memory.deleteTree` with `dryRun: false`, close, refetch.

---

## 10. Dev workflow

- `packages/web/`: `./bun --cwd packages/web run dev` starts Vite on an ephemeral port with a proxy for `/rpc` → `http://localhost:3000`.
- Developer runs `me serve` in one terminal (the backend) and `bun run dev` in another (hot-reloading UI). Vite's proxy relays `/rpc` to the live `me serve`, so auth, server selection, and engine selection all flow through the real backend.
- Production: `me serve` serves the prebuilt bundle from embedded assets — no Vite in the shipped binary.

---

## 11. Build & packaging changes

1. Add `packages/web` to the workspace root `package.json`.
2. Root scripts:
   - `build:web` → `bun --cwd packages/web run build`
   - `build:cli` updated to depend on `build:web`
   - `check` unchanged; `packages/web` gets its own typecheck via workspace typecheck.
3. CLI build uses `bun build --compile` with an asset-loader strategy for the `dist/` directory (prototype with Bun's `file:` imports; fall back to embedding via generated TS module that base64-encodes each file if needed).
4. Add to `.gitignore`: `packages/web/dist/`.

---

## 12. Step-by-step roadmap

Staged so each step produces a runnable artifact.

1. **Scaffold `packages/web`** — Vite + React + Tailwind + TypeScript. Empty app that says "hi". Verify `bun --cwd packages/web run dev` works.
2. **Scaffold `me serve`** — new command, port discovery, `--port`, `--host`, `--no-open`, `--server` resolution, credentials lookup. Serves a hardcoded HTML "hello from me serve" on `/`.
3. **Wire the proxy** — `POST /rpc` forwards to the remote engine with the stored API key. Test via `curl` against a real engine.
4. **Embed static assets** — build the web app, load its `dist/` into the binary, serve them. The hello page now comes from React.
5. **RPC client + TanStack Query setup** — implement `rpc()` helper + `useMemories` / `useMemory` hooks. Display the raw JSON result in the UI as a sanity check.
6. **Tree build + render** — `tree-build.ts`, `TreeView`, `TreeNode`. Click selects a memory id into zustand; right pane shows raw JSON of the selected memory.
7. **Markdown viewer** — replace raw JSON with `react-markdown`. Read-only metadata panel below.
8. **Simple search bar** — input wired to filter state, filter flows into the query, tree re-renders with the filtered subset. URL sync for the simple field + selected id.
9. **Advanced search panel** — all fields, toggle, clear, full URL sync.
10. **Monaco editor + frontmatter** — edit mode, parse/serialize frontmatter, dirty tracking, Save via `memory.update`, navigation guard.
11. **Delete flows** — `DeleteMemoryDialog`, `DeleteTreeDialog` with dry-run count, context menus on the tree.
12. **Auto-open browser + polish** — open on bind, error toasts, empty states, tailwind pass for spacing/typography.
13. **Check + docs** — `./bun run check`, add `docs/cli/serve.md`, update top-level `README` and `docs/getting-started.md`.

---

## Open notes / defaults I chose

- **Port discovery**: default 3000, auto-increment only when default; explicit `--port` is strict. Reason: when a user types a port, they mean that port.
- **Host**: locked to `127.0.0.1`. A `--host` flag is included for symmetry but I'd default to loopback only until we design auth.
- **List-all implementation**: `memory.search({ tree: "*", limit: 1000 })`. If treeFilterSchema's wildcard behaves differently than expected, we fall back to adding a thin `memory.list` RPC — flagged as a risk; verify in step 5.
- **Monaco bundle size**: Monaco is ~2 MB gzipped. Worth it for the UX, but worth calling out. If we want to shave it later, swap to CodeMirror 6.
