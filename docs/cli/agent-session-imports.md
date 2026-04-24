# Agent session imports

Shared reference for the per-agent `import` subcommands:

- [`me claude import`](me-claude.md#me-claude-import)
- [`me codex import`](me-codex.md#me-codex-import)
- [`me opencode import`](me-opencode.md#me-opencode-import)

Each source-native message becomes one memory. Re-running the same command only inserts newly-seen messages (deterministic UUIDs make re-imports idempotent).

## Shared options

All three subcommands accept the same flags (with one extra flag on `me claude import`).

| Option | Description |
|--------|-------------|
| `--source <dir>` | Override the default source directory for this tool. |
| `--project <cwd>` | Only import sessions whose cwd equals or is below this path. |
| `--since <iso>` | Only import sessions started at or after this ISO 8601 timestamp. |
| `--until <iso>` | Only import sessions started at or before this ISO 8601 timestamp. |
| `--tree-root <path>` | Tree root under which `<slug>.<sessions-node-name>` nodes are placed. Default: `projects`. Must match `[a-z0-9_]+(\.[a-z0-9_]+)*`. |
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

Each imported message is stored under:

```
<tree-root>.<project_slug>.<sessions-node-name>
```

For example, a Claude message from a session run in `/Users/me/dev/memory-engine` ends up under `projects.memory_engine.agent_sessions` by default. Every message from every session in a project shares that same tree node; individual sessions are distinguished by `meta.source_session_id`.

Project slugs come from the git repo root directory name when the cwd is inside a repo, or from `basename(cwd)` otherwise. Slug collisions (two different cwds that normalize to the same label) are resolved automatically by appending a 4-char hash suffix -- the first cwd seen gets the plain slug, subsequent ones get `slug_<hash>`. The full cwd is always preserved in `meta.source_cwd`.

## Idempotency

Each imported message gets a deterministic UUIDv7 derived from `(tool, session_id, message_id, timestamp)`. On re-import:

1. The importer looks up each message by that id.
2. If the memory already exists and `meta.importer_version` matches, it is skipped.
3. Otherwise the memory is (re)written.

Source files are append-only for all three tools, so re-importing an in-progress session simply inserts its newly-appended messages on the next run.

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
| `imported_at` | ISO 8601 timestamp of this import run. |
| `importer_version` | Version tag of the importer schema. |

Temporal is a point-in-time at the message's timestamp.
