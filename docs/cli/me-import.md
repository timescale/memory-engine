# me import

Get data into Memory Engine — one subcommand per source.

## Commands

- [me import memories](#me-import-memories) -- import memory records from files or stdin (md/yaml/json/ndjson)
- [me import claude](#me-import-claude--codex--opencode) -- import Claude Code sessions
- [me import codex](#me-import-claude--codex--opencode) -- import Codex sessions
- [me import opencode](#me-import-claude--codex--opencode) -- import OpenCode sessions
- [me import git](#me-import-git) -- import a repo's git commit history
- [me import git-hook](#me-import-git-hook) -- install a post-commit hook that keeps git history memories current

There is no bare default: `me import <file>` does not parse — use `me import memories <file>`.

---

## me import memories

Import memory records from files or stdin. `me memory import` is an alias of this command.

```
me import memories [files...] [options]
```

See [me memory import](me-memory.md#me-memory-import) for the full option reference, format detection, skip semantics, and chunking behavior, and [File Formats](../formats.md) for the record schemas.

---

## me import claude / codex / opencode

Import agent sessions from each tool's native storage. The per-agent spellings (`me claude import`, `me codex import`, `me opencode import`) are aliases of these commands.

```
me import claude [options]
me import codex [options]
me import opencode [options]
```

See [agent session imports](agent-session-imports.md) for the shared option reference, tree layout, idempotency rules, content shape, and metadata schema.

---

## me import git

Import a repo's git commit history as memories — one memory per commit, holding the commit message plus a capped changed-file list. Commit intent ("why did we do X") and touched paths become searchable agent context.

```
me import git [repo] [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `repo` | no | Path inside the repo to import. Default: the current directory. |

| Option | Description |
|--------|-------------|
| `--branch <rev>` | Branch, tag, or rev to walk. Default: `HEAD`. |
| `--since <date>` | Only commits at/after this date (any format git accepts). |
| `--until <date>` | Only commits at/before this date. |
| `--max-count <n>` | Import at most this many recent commits. |
| `--full` | Walk the full history (skip the incremental high-water lookup). |
| `--no-merges` | Drop all merge commits. |
| `--no-file-list` | Omit the changed-file list from commit memories. |
| `--tree-root <path>` | Tree root under which `<slug>.git_history` is placed. Default: `share.projects`. |
| `--dry-run` | Parse and report what would be imported without writing. |
| `-v, --verbose` | Per-commit progress output. |

### Tree layout

Commits are stored under:

```
<tree-root>.<project_slug>.git_history
```

The project slug is derived exactly as for [agent session imports](agent-session-imports.md#tree-layout) (git remote repo name, else repo root directory name), so a project's commit history sits next to its `agent_sessions` node — e.g. `share.projects.memory_engine.git_history`.

### Content shape

Each memory's content is the commit subject, the body (truncated past 64 KiB), and a `Files:` block listing up to 50 changed paths with `(+added -deleted)` line counts (`(binary)` for binary files). `--no-file-list` omits the block.

Merge commits with no message body (`Merge branch 'x'` boilerplate) are skipped by default; merges that carry a body — GitHub PR merge commits put the PR title there — are imported. `--no-merges` drops all merges.

### Idempotency and incremental re-runs

Each commit gets a deterministic UUIDv7 keyed by `(tree, sha)` with the commit date as its timestamp half. Re-imports are server-side no-ops: an already-imported commit is skipped, never duplicated.

Re-runs are also incremental: the newest already-imported commit is looked up server-side, and when it is an ancestor of the target rev only `<sha>..<rev>` is walked. After a force-push (or when importing a different branch) the walk falls back to the full log — still safe, because the deterministic ids dedupe the overlap. Explicit bounds (`--since`, `--until`, `--max-count`, `--full`) always walk exactly what they say.

### Metadata

| Key | Description |
|-----|-------------|
| `type` | Always `"git_commit"`. |
| `sha` | Full 40-hex commit sha. |
| `source_git_repo` | Git remote URL (when the repo has one). |
| `source_project_slug` | ltree-safe project label (same as the tree subnode). |
| `author_name` / `author_email` | Commit author. |
| `author_date` / `commit_date` | ISO 8601 author and committer dates. |
| `files_changed` / `insertions` / `deletions` | Change stats (binary files excluded from line counts). |
| `is_merge` | `true` on merge commits (absent otherwise). |
| `imported_at` | ISO 8601 timestamp of this import run. |
| `importer_version` | Version tag of the importer schema. |

Temporal is a point-in-time at the commit date.

### Example

Backfill this repo's history, then keep it current with cheap re-runs:

```bash
me import git --dry-run -v   # preview
me import git                # full backfill (first run)
me import git                # later: walks only commits since the last import
```

---

## me import git-hook

Install a managed git `post-commit` hook that re-runs [`me import git`](#me-import-git) in the background after every commit, keeping the repo's git history memories current without manual re-runs.

```
me import git-hook [repo]
me import git-hook --remove
```

| Argument | Required | Description |
|----------|----------|-------------|
| `repo` | no | Path inside the repo. Default: the current directory. |

| Option | Description |
|--------|-------------|
| `--remove` | Remove the managed block (and the hook file, if nothing else remains). |

### What gets installed

A marker-delimited managed block in the repo's effective `post-commit` hook (worktree-aware, resolved via `git rev-parse --git-path hooks`):

```sh
# >>> memory-engine (managed by `me import git-hook`) >>>
# Best-effort and asynchronous: never blocks or fails the commit.
("/path/to/me" import git >/dev/null 2>&1 &)
# <<< memory-engine <<<
```

The embedded `me` path is absolute, so commits from GUI git clients (no shell PATH) still trigger the import. If a `post-commit` hook already exists, the block is appended once and the existing script is preserved; re-running `git-hook` replaces the block in place (idempotent, refreshes the embedded path). A foreign hook that exits early never reaches the appended block — move the block up manually in that case.

Because [`me import git`](#me-import-git) is high-water incremental, **any** hook fire catches up the entire backlog — including commits that arrived via pull, merge, or rebase since the last fire. A single `post-commit` hook therefore suffices; there is no post-merge/post-rewrite matrix to install.

### Hooks managers (core.hooksPath)

When the repo routes hooks through `core.hooksPath` (husky, lefthook, and similar committed hooks managers), `git-hook` refuses rather than write into committed files. Add this line to the manager's `post-commit` hook instead:

```sh
me import git >/dev/null 2>&1 &
```

### Scope and failure mode

The hook lives in `.git/hooks` — per clone, never committed, never pushed. CI checkouts and teammates' clones are unaffected; each clone opts in by running `me import git-hook` itself ([`me claude init`](me-claude.md#me-claude-init) offers it as a setup step).

The import is deliberately silent and best-effort: it never blocks or fails a commit, which also means auth or connectivity problems won't surface at commit time. If history seems stale, run `me import git` manually to see the error — the next successful fire catches everything up.
