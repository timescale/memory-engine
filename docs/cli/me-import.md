# me import

Import agent conversations from local CLI agents (Claude Code, Codex, OpenCode) into the active engine as memories.

Each conversation session on disk becomes one memory. Content includes a metadata header (tool, model, project, branch, duration, message counts) followed by the conversation in Markdown. Imports are idempotent -- re-running the same command only adds new or changed sessions.

## Commands

- [me import claude](#me-import-claude) -- import Claude Code sessions
- [me import codex](#me-import-codex) -- import Codex sessions
- [me import opencode](#me-import-opencode) -- import OpenCode sessions

---

## Shared options

All three subcommands accept the same flags (with one extra flag on `claude`).

| Option | Description |
|--------|-------------|
| `--source <dir>` | Override the default source directory for this tool. |
| `--project <cwd>` | Only import sessions whose cwd equals or is below this path. |
| `--since <iso>` | Only import sessions started at or after this ISO 8601 timestamp. |
| `--until <iso>` | Only import sessions started at or before this ISO 8601 timestamp. |
| `--tree-root <path>` | Tree root to store memories under. Default: `agent_conversations`. Must match `[a-z0-9_]+(\.[a-z0-9_]+)*`. |
| `--flat` | Store all sessions directly under `--tree-root` with no project subnode. |
| `--full-transcript` | Include reasoning, tool calls, and tool results in the memory body (default: user + assistant text only). |
| `--include-temp-cwd` | Include sessions whose cwd is a system temp directory (`/tmp`, `/private/var/folders/...`). Off by default. |
| `--include-trivial` | Include sessions with fewer than 2 user turns (one-shot queries, warm-up pings, aborted sessions). Off by default. |
| `--dry-run` | Parse and report what would be imported without writing anything. |
| `-v, --verbose` | Per-session progress lines. |

`me import claude` additionally accepts:

| Option | Description |
|--------|-------------|
| `--include-sidechains` | Include subagent sessions (`agent-*.jsonl`). Off by default. |

## Tree layout

By default, each imported session is stored under:

```
<tree-root>.<project_slug>
```

For example, a Claude session run in `/Users/me/dev/memory-engine` ends up under `agent_conversations.memory_engine`. Use `--flat` to drop the project subnode and store all sessions directly under `--tree-root`.

Project slugs come from the git repo root directory name when the cwd is inside a repo, or from `basename(cwd)` otherwise. Slug collisions (two different cwds that normalize to the same label) are resolved automatically by appending a 4-char hash suffix -- the first cwd seen gets the plain slug, subsequent ones get `slug_<hash>`. The full cwd is always preserved in `meta.source_cwd`.

To keep a simplified import and a `--full-transcript` import side by side, point them at different roots:

```bash
me import claude
me import claude --full-transcript --tree-root agent_conversations_full
```

## Idempotency

Each imported session gets a deterministic UUIDv7 derived from `(tool, sessionId, startedAt)`. On re-import:

1. The importer looks up the existing memory by that ID.
2. If `meta.last_message_id` matches the current last message in the source file, the session is skipped.
3. If it has changed (session grew since the last import), the memory is updated in place with new content, meta, and temporal range.

This makes repeated imports cheap: one lookup per session and a write only when content has actually changed.

## Content shape

Default content is a Markdown document with a metadata header and the `user` and `assistant` text turns in order. Reasoning/thinking blocks, tool calls, and tool results are excluded. Example:

```markdown
# Debugging the embedding worker

- Tool: Claude v2.1.107
- Model: anthropic/claude-opus-4-7
- Project: /Users/me/dev/memory-engine
- Branch: main @ 2b23f7c6
- Duration: 2026-04-14T17:19:23Z → 2026-04-14T18:45:12Z (1h 26m)
- Messages: 42 user / 38 assistant / 12 tool calls

## Conversation

### user (17:19:23Z)
Help me debug the embedding worker...

### assistant (17:19:28Z)
Looking at the worker, I see...
```

With `--full-transcript`, additional turn kinds are included (`assistant (reasoning)`, `tool call: <name>`, `tool result: <name>`, `system`).

## Metadata

Each imported memory carries:

| Key | Description |
|-----|-------------|
| `type` | Always `"agent_conversation"`. |
| `source_tool` | `"claude"` / `"codex"` / `"opencode"`. |
| `source_session_id` | Tool-native session identifier. |
| `source_session_title` | Session title when the source supplies one. |
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
| `source_file` | Absolute path of the session file on disk. |
| `last_message_id` | ID of the last message seen -- used for change detection. |
| `last_message_at` | Timestamp of the last message (ISO 8601). |
| `message_counts` | `{user, assistant, tool_calls}` counts. |
| `tokens` | `{input, output, reasoning, cache_read, cache_write}` when the source records them. |
| `cost_usd` | Aggregate USD cost when the source records it. |
| `content_mode` | `"default"` or `"full_transcript"`. |
| `imported_at` | ISO 8601 timestamp of this import run. |
| `importer_version` | Version tag of the importer schema. |

Temporal range is `[started_at, ended_at)` for multi-message sessions, or a point-in-time for single-message sessions.

---

## me import claude

Import Claude Code sessions from `~/.claude/projects/<encoded-cwd>/<session>.jsonl`.

```
me import claude [options]
```

See [Shared options](#shared-options) plus `--include-sidechains` above.

**Default filters (off by default, opt in via flags):**

- Sidechain (`agent-*.jsonl`) files are skipped. These are subagent/Task spawns.
- Sessions whose cwd is under `/tmp`, `/private/tmp`, `/private/var/folders`, or `/var/folders` are skipped.
- Sessions with fewer than 2 user turns are skipped (one-shot queries, warm-up pings, and aborted sessions). Sessions where the user didn't follow up after the first answer are considered one-shot and dropped by default.

In-progress sessions are imported as-is — the next import will update them in place via deterministic-UUID change detection on `last_message_id`.

Example: first-time import of Claude history for a specific project, as a dry run:

```bash
me import claude --project /Users/me/dev/memory-engine --dry-run --verbose
```

---

## me import codex

Import Codex sessions from `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and `~/.codex/archived_sessions/*.jsonl`.

```
me import codex [options]
```

See [Shared options](#shared-options).

Codex sessions include git commit, branch, and remote URL in `session_meta`, so the importer captures all three. Token counts are harvested from `token_count` event messages.

Both the recent on-disk format (with a leading `session_meta` line wrapping payloads in `response_item` / `event_msg`) and the legacy format (bare response-item-like objects per line) are handled.

---

## me import opencode

Import OpenCode sessions from `~/.local/share/opencode/storage/`.

```
me import opencode [options]
```

See [Shared options](#shared-options).

OpenCode stores data across four directories:

- `project/<project-id>.json` -- project metadata
- `session/<project-id>/ses_<id>.json` -- session metadata (title, directory, timestamps)
- `message/ses_<id>/msg_<id>.json` -- per-message metadata (role, model, tokens, cost)
- `part/msg_<id>/prt_<id>.json` -- content parts (text, reasoning, tool, step-start/finish)

The importer stitches these together, ordering parts by their `time.start` to rebuild the turn sequence. Cost and tokens are summed across all messages in the session. OpenCode's `agent` field becomes `meta.source_agent_mode` (e.g. `"plan"`).
