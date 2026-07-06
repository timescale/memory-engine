# Agent session imports

Shared reference for the agent-session import subcommands:

- `me import claude` ([`me claude import`](me-claude.md#me-claude-import) is its alias)
- `me import codex` ([`me codex import`](me-codex.md#me-codex-import) is its alias)
- `me import opencode` ([`me opencode import`](me-opencode.md#me-opencode-import) is its alias)

Each source-native message becomes one memory, named `msg_<message_id>` under a per-session tree node. Re-running the same command only inserts newly-seen messages — the `(tree, name)` slot makes re-imports idempotent.

## Shared options

All three subcommands accept the same flags (with one extra flag on the Claude importer).

| Option | Description |
|--------|-------------|
| `--source <dir>` | Override the default source directory for this tool. |
| `--project <cwd>` | Only import sessions whose cwd equals or is below this path. |
| `--since <iso>` | Only import sessions started at or after this ISO 8601 timestamp. |
| `--until <iso>` | Only import sessions started at or before this ISO 8601 timestamp. |
| `--tree-root <path>` | Tree root under which `<slug>/<sessions-node-name>` nodes are placed for projects without a [`.me` tree](../project-config.md). Default: your global [`tree_root`](../project-config.md#changing-the-default-tree-root-tree_root) override, else the private `~/projects` (your own home). An explicit value also overrides every project's `.me` tree for the run. Accepts ltree labels (`[A-Za-z0-9_-]`) separated by `/`, with an optional leading `~` for your home. |
| `--sessions-node-name <name>` | Per-project node name for imported agent sessions. Default: `agent_sessions`. Must match `[a-z0-9_]+`. |
| `--full-transcript` | Also store reasoning, tool calls, and tool results as their own message memories (default: user + assistant text only). |
| `--include-temp-cwd` | Include sessions whose cwd is a system temp directory (`/tmp`, `/private/var/folders/...`). Off by default. |
| `--include-trivial` | Include sessions with fewer than 2 user messages (one-shot queries, warm-up pings, aborted sessions). Off by default. |
| `--dry-run` | Parse and report what would be imported without writing anything. |
| `-v, --verbose` | Per-session progress lines. |

`me claude import` additionally accepts:

| Option | Description |
|--------|-------------|
| `--include-sidechains` | Include subagent sessions (`agent-*.jsonl`). Off by default. |

## Tree layout

Each session is its own tree node, and each message is a named leaf under it:

```
<tree-root>/<project_slug>/<sessions-node-name>/<session_id>/msg_<message_id>
```

For example, a Claude message from a session run in `/Users/me/dev/memory-engine` ends up at `~/projects/memory_engine/agent_sessions/<session_id>/msg_<message_id>` by default — under your **private** home tree, visible only to you. Each session is browsable as a folder, and an individual message is addressable by its path (`me get '~/projects/memory_engine/agent_sessions/<session_id>/msg_<message_id>'`). The session id is normalized to an ltree label for the node; the raw id is also kept in `meta.source_session_id`.

**Every session routes by its own project's config**, exactly like the live capture hook: each session's recorded cwd is resolved against that project's committed [`.me/config.yaml`](../project-config.md) — its **server** (whitelist-gated, the same credential-safety rule as a local run), **space**, and **tree** (sessions nest directly under it, `<tree>/<sessions-node-name>/…`, no slug). Sessions from projects without a `.me` use the run's own server/space and the `~/projects` + per-slug layout. The documented precedence holds throughout — an explicit `--server`/`--tree-root` flag or `ME_*` env still outranks any project's `.me`.

A project the sweep can't safely write for is **skipped and tallied** (reported as session skip reasons) instead of failing the run: `untrusted_me_server` (its `.me` pins a server outside your [trusted list](../project-config.md#trusted-servers-credential-safety)), `no_credentials_for_server` (you're not logged in there and hold no api key), `no_space_for_project`, or `invalid_me_config` (malformed `.me`). Run a local import inside that project to see the precise error.

Project slugs come from the git repo root directory name when the cwd is inside a repo, or from `basename(cwd)` otherwise. Slug collisions (two different cwds that normalize to the same label) are resolved automatically by appending a 4-char hash suffix -- the first cwd seen gets the plain slug, subsequent ones get `slug_<hash>`. The full cwd is always preserved in `meta.source_cwd`.

## Idempotency

Idempotency is keyed on `(tree, name)` — the per-session node plus the `msg_<message_id>` leaf. (The id is a timestamp-prefixed UUIDv7 with a random tail, so messages still sort chronologically by id; the same message gets a fresh id each run, but the `(tree, name)` slot keeps it on the existing row.) Re-imports reconcile **server-side**: every planned message is submitted with `onConflict: 'replace'`, which inserts new slots and rewrites an existing one only when content/meta/temporal differ. Since `meta.importer_version` is part of meta, an importer-version bump makes meta differ and re-renders previously-imported messages in the same batched pass, while an unchanged re-import is a no-op. There is no per-session lookup and no session-size limit — a session with tens of thousands of imported messages reconciles exactly like a small one.

Source files are append-only for all three tools, so re-importing an in-progress session simply inserts its newly-appended messages on the next run. The live-capture hook additionally narrows each submission to the messages after the newest already-imported one (a single `limit 1` search) — purely a bandwidth optimization; correctness never depends on it.

`--dry-run` reports every parsed message as a would-be insert: without submitting, there is no server classification into inserted/updated/skipped.

## Content shape

Each memory's content is the raw text of the message. Role, session id, project, git state, and block kinds live in `meta`.

- Default mode keeps only the `text` blocks of each message. Messages with no text blocks (for example, a Claude user event that only carries a `tool_result`) are skipped.
- `--full-transcript` keeps every block kind. Messages are rendered as their blocks joined with blank lines, and standalone reasoning / tool-call / tool-result items (for example, Codex response items of those types) are stored as their own memories.

## Metadata

Each imported memory carries:

| Key | Description |
|-----|-------------|
| `type` | Always `"agent_session"`. |
| `source_tool` | `"claude"` / `"codex"` / `"opencode"`. |
| `source_session_id` | Tool-native session identifier. |
| `source_session_title` | Session title when the source supplies one. |
| `source_message_id` | Source-native message id (or a stable synthesized id for Codex items with no native id). |
| `source_message_role` | `user` / `assistant` / `reasoning` / `tool_call` / `tool_result` / `system`. |
| `source_message_block_kinds` | Ordered list of block kinds composing this message. |
| `source_cwd` | Absolute working directory. |
| `source_project_slug` | ltree-safe project label (same as the tree subnode). |
| `source_git_root` | Git repo root (if detected and distinct from cwd). |
| `source_git_branch` | Branch at session start. |
| `source_git_commit` | Commit hash at session start. |
| `source_git_repo` | Git remote URL. |
| `source_tool_version` | CLI version string. |
| `source_model` | Model id (e.g. `claude-opus-4-5`, `gemini-3-pro-preview`). |
| `source_provider` | Model provider (`anthropic`, `openai`, `google`, ...). |
| `source_agent_mode` | OpenCode agent mode (e.g. `plan`). |
| `source_tool_name` | Tool name for `tool_call` / `tool_result` messages. |
| `source_file` | Absolute path of the session file on disk. |
| `content_mode` | `"default"` or `"full_transcript"`. |
| `importer_version` | Version tag of the importer schema. |
| `$prev` | Path of the previous message in the session (absent on the first message). |
| `$thread` | The session id, shared by every message — the thread grouping key. |

`$prev` and `$thread` are the reserved [thread-link keys](../concepts.md#reserved-thread-link-keys): they let the web UI walk a session with **Previous** / **Next** buttons and pull up the whole session via **Entire thread**. `$next` is not stored — it is derived from `$prev`. Because `$prev` is a memory path (not an id) it stays stable across re-imports.

Temporal is a point-in-time at the message's timestamp.
