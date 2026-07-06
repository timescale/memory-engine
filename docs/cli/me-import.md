# me import

Get data into Memory Engine — one subcommand per source.

## Commands

- [me import memories](#me-import-memories) -- import memory records from files or stdin (md/yaml/json/ndjson)
- [me import claude](#me-import-claude--codex--opencode) -- import Claude Code sessions
- [me import codex](#me-import-claude--codex--opencode) -- import Codex sessions
- [me import opencode](#me-import-claude--codex--opencode) -- import OpenCode sessions
- [me import granola](#me-import-granola) -- import Granola meeting notes and transcripts
- [me import git](#me-import-git) -- import a repo's git commit history
- [me import git-hook](#me-import-git-hook) -- install a post-commit hook that keeps git history memories current
- [me import docs](#me-import-docs) -- import a directory's markdown docs (git-aware)
- [me import slab](#me-import-slab) -- import a Slab knowledge-base export (a directory or `.zip`)

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

## me import granola

Import meetings from [Granola](https://granola.ai) — one memory per meeting, holding the AI summary notes and (by default) the full transcript. Past meetings become searchable agent context ("what did we decide about X", "who was in the Y review").

```
me import granola [options]
```

| Option | Description |
|--------|-------------|
| `--tree-root <path>` | Tree root under which `<document_id>` leaves are placed. Default: `~/granola`. |
| `--since <iso>` | Only import meetings started at or after this ISO 8601 timestamp. |
| `--until <iso>` | Only import meetings started at or before this ISO 8601 timestamp. |
| `--no-transcript` | Import notes only, skipping the full meeting transcript (and its per-meeting API call). |
| `--include-invalid` | Include notes Granola did not flag as a valid meeting (ad-hoc notes, calendar stubs). |
| `--granola-dir <dir>` | Override the Granola application-support directory (default: the standard macOS path). |
| `--dry-run` | Fetch and report what would be imported without writing. |

### Authentication (no separate login)

The import reuses the **Granola desktop app's** existing session — there is no separate `me`-side Granola login. It reads Granola's locally-stored, `safeStorage`-encrypted WorkOS tokens (decrypting them via the macOS login keychain), refreshes the short-lived access token through Granola's API, then pulls your meetings. Requirements:

- The Granola desktop app is **installed and signed in** on this machine.
- **macOS only** for now (the credential read uses the login keychain). On other platforms the command exits with an actionable error.

If the token refresh fails (e.g. Granola has been signed out), open the Granola app to refresh its session and re-run.

### Tree layout

Each meeting is a named leaf (its Granola `document_id`) under the tree root:

```
<tree-root>/<document_id>
```

The default root is your personal home (`~/granola`), so meetings are private to you. Pass `--tree-root /share/meetings` (or similar) to import into a shared space instead.

### Content shape

Each memory's content is a self-contained Markdown document: a title heading, a metadata line (date, attendees), the AI **summary notes**, and — unless `--no-transcript` — the full **transcript**. Notes are sourced, in order of preference, from the meeting's own `notes_markdown`, then an AI summary panel (its structured content, else its HTML). Transcript segments are grouped into speaker turns labelled `Me` (your microphone) and `Them` (everyone else); Granola does not attribute remote speakers by name.

Meetings Granola flagged as not a valid meeting are skipped by default (`--include-invalid` keeps them), as are meetings with neither notes nor a transcript.

### Idempotency and re-runs

Idempotency is keyed on `(tree, document_id)` — each meeting is named by its Granola document id. The id is a timestamp-prefixed UUIDv7 (meeting start in the prefix, random tail), so meetings sort by date on the id. Re-imports reconcile in place via the server's content-aware upsert: an unchanged meeting is a no-op, a meeting whose notes/transcript changed (or an importer-version bump) is rewritten, and nothing is ever duplicated. Run it on a schedule to keep your meeting memory current.

### Metadata

| Key | Description |
|-----|-------------|
| `type` | Always `"granola_meeting"`. |
| `source_tool` | Always `"granola"`. |
| `source_document_id` | Granola document id (also the leaf name). |
| `display_name` | Human label for the web tree (`"Title — YYYY-MM-DD"`); the leaf `name` stays the document id so re-imports stay idempotent. |
| `source_workspace_id` | Granola workspace id (when present). |
| `source_calendar_event_id` | Google Calendar event id (when the meeting has one). |
| `attendees` | Calendar attendee emails (when present). |
| `content_mode` | `"with_transcript"` or `"notes_only"`. |
| `has_notes` / `has_transcript` | Whether each section was captured. |
| `transcript_segment_count` | Number of transcript segments. |
| `valid_meeting` | Granola's valid-meeting flag (when set). |
| `importer_version` | Version tag of the importer schema. |

Temporal spans the meeting: calendar start→end when known, else the meeting's created time and last transcript segment.

### Example

```bash
me import granola --dry-run            # preview everything Granola has
me import granola                      # full import (notes + transcripts) into ~/granola
me import granola --no-transcript      # notes only (faster; fewer API calls)
me import granola --since 2026-01-01   # just this year's meetings
```

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
| `--tree <path>` | Full project tree to place `git_history` under (no slug appended — `me import git` is single-repo). Default: the **target repo's** [`.me` tree](../project-config.md) (resolved from the repo path, so it works from any cwd; its `.me` server/space pins apply too, whitelist-gated), else `<tree_root>/<slug>` (your global [`tree_root`](../project-config.md#changing-the-default-tree-root-tree_root) override, default the private `~/projects`). |
| `--dry-run` | Parse and report what would be imported without writing. |
| `-v, --verbose` | Per-commit progress output. |

### Tree layout

Each commit is a named leaf (the commit `<sha>`) under the project's `git_history` node:

```
<tree>/git_history/<sha>
```

`<tree>` is the full project node — `--tree`, else the repo's [`.me` tree](../project-config.md), else `<tree_root>/<project_slug>` (the private `~/projects` unless your global config overrides `tree_root`). The default project slug is derived exactly as for [agent session imports](agent-session-imports.md#tree-layout) (git remote repo name, else repo root directory name), so a project's commit history sits next to its `agent_sessions` node — e.g. a commit lands at `~/projects/memory_engine/git_history/<sha>` and is addressable by that path (or at `/share/projects/memory_engine/git_history/<sha>` when the project's `.me` tree pins the shared layout).

### Content shape

Each memory's content is the commit subject, the body (truncated past 64 KiB), and a `Files:` block listing up to 50 changed paths with `(+added -deleted)` line counts (`(binary)` for binary files). `--no-file-list` omits the block.

Merge commits with no message body (`Merge branch 'x'` boilerplate) are skipped by default; merges that carry a body — GitHub PR merge commits put the PR title there — are imported. `--no-merges` drops all merges.

### Idempotency and incremental re-runs

Idempotency is keyed on `(tree, sha)` — each commit is named by its sha. The id is a timestamp-prefixed UUIDv7 (commit date in the prefix, random tail), so commits sort by date on the id. Re-imports are server-side no-ops: an already-imported commit is skipped, never duplicated.

Re-runs are also incremental: the newest already-imported commit is looked up server-side, and when it is an ancestor of the target rev only `<sha>..<rev>` is walked. After a force-push (or when importing a different branch) the walk falls back to the full log — still safe, because the `(tree, sha)` key dedupes the overlap. Explicit bounds (`--since`, `--until`, `--max-count`, `--full`) always walk exactly what they say.

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
| `importer_version` | Version tag of the importer schema. |
| `$prev` | Path of the first-parent commit (absent on the root commit). |

`$prev` is the reserved [thread-link key](../concepts.md#reserved-thread-link-keys) that lets the web UI step through history with **Previous** / **Next**. Commits link along the first-parent chain, stepping through dropped (boilerplate) merges to the nearest imported ancestor. Unlike the session importers, git sets no `$thread` — a repo's history is a DAG, not one linear thread — so there is no "Entire thread" grouping; `$next` is derived from `$prev`.

Temporal is a point-in-time at the commit date.

### Example

Backfill this repo's history, then keep it current with cheap re-runs:

```bash
me import git --dry-run -v   # preview
me import git                # full backfill (first run)
me import git                # later: walks only commits since the last import
```

---

## me import docs

Import a directory's markdown docs as memories — one memory per file, with the directory layout mirrored as the tree path. Works on any folder of markdown; inside a git repo, discovery and dating get smarter (gitignore respected, git last-modified dates).

```
me import docs [dir] [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `dir` | no | Directory to import — the **import root**; tree paths derive relative to it (not the repo toplevel). Default: the current directory. |

| Option | Description |
|--------|-------------|
| `--tree <path>` | Full project tree to place `docs` under (no slug appended). Default: the repo's [`.me` tree](../project-config.md), else `<tree_root>/<slug>` (your global [`tree_root`](../project-config.md#changing-the-default-tree-root-tree_root) override, default the private `~/projects`) — same resolution as [`me import git`](#me-import-git), so a project's docs sit next to its `git_history` and `agent_sessions` nodes. |
| `--include <globs...>` | Glob patterns to import, **replacing** the default set (`**/*.md`, `**/*.markdown`, `**/*.mdx`). |
| `--exclude <globs...>` | Glob patterns to drop from the include set. |
| `--temporal-key <key>` | Frontmatter key parsed as the memory's temporal start (e.g. `date` for blogs/ADRs). Falls back to git last-modified; works in plain directories and shallow clones too. |
| `--no-temporal` | No temporal and no date-seeded ids (also skips the git log pass). |
| `--prune` | Delete previously-imported docs under the docs root that are absent from this walk. **Full-corpus runs only** — see [Pruning](#pruning-deletions-and-renames). |
| `--dry-run` | Discover and report what would be imported without writing (with `--prune`: lists what would be deleted). |
| `-v, --verbose` | Per-file progress output (prints each `tree / name`). |

### Discovery: git-aware, git-optional

Git is an enhancer, not a requirement. When `dir` is inside a git work tree (**git mode**), files come from `git ls-files` — tracked **plus untracked-but-not-ignored**, so a doc you just wrote imports while gitignored build output stays out. In a plain directory (**plain mode**), the walk skips hidden files/dirs and `node_modules` (there is no gitignore to lean on). `--include`/`--exclude` are globs applied client-side in **both** modes, so they mean exactly the same thing with and without git. The output names the mode a run used.

### Tree layout

Each file is a named leaf under the project's `docs` node, mirroring its directory path **relative to `dir`**:

```
<tree>/docs/<sub>/<dirs>/<file-name>
```

Directory segments are normalized to ltree labels and the leaf name is a filename-derived slug keeping its (lowercased) extension, unique within its tree — e.g. `docs/guides/Getting Started.md` in repo `acme` lands at `~/projects/acme/docs/docs/guides/getting-started.md`. Files at the import root sit directly on the `docs` node. Note that pointing a later run at a different `dir` changes where files land.

### Frontmatter is document data, never engine fields

Unlike [`me import memories`](#me-import-memories) — where frontmatter *is* the memory record — this importer never reads engine fields (`id`, `name`, `tree`, `temporal`) from frontmatter: real-world docs own that vocabulary (Docusaurus `id:`, Hugo `slug:`), and the engine fields derive from the file path so idempotency keys stay stable. The parsed frontmatter object is preserved verbatim under **`meta.doc`**, and it is stripped from the content. Two exceptions use frontmatter *as data*: a string `title:` wins over the first-H1 heuristic for `meta.title`, and `--temporal-key` designates one key as the temporal source. A file whose frontmatter block is invalid YAML (or a non-object) imports with its content verbatim and no `meta.doc` — a broken header never fails the file.

### Content shape

The content is the markdown body with frontmatter stripped. `.mdx` files additionally drop top-level `import`/`export` statement lines (module wiring noise) — lines inside fenced code blocks are kept, since usage examples legitimately contain imports, and JSX component tags stay (the same tolerable noise as raw HTML in `.md`). Content past 64 KiB is truncated with a marker and flagged `meta.truncated`. Files that are empty after stripping are skipped — there is nothing to embed.

### Temporal and ordering

The temporal is a point-in-time answering "when is this content from": the `--temporal-key` frontmatter value when given and parseable, else the file's **git last-modified** date (author date of the newest commit touching the path, computed in one streamed `git log` pass — never per-file spawns). There is deliberately no filesystem-mtime fallback: mtime churns on clone/copy/checkout, which would make a byte-identical re-import rewrite every row. Per-file degradation, not per-run: an uncommitted file simply gets no git date. In a **shallow clone** every path's history collapses to the shallow boundary, so git dates are dropped with a warning (`--temporal-key` still applies).

A dated doc seeds a date-prefixed UUIDv7 id, so docs sort by recency in default (id) order. On re-import the existing row — and its id — is kept, so id order reflects recency at first ingest while `temporal` tracks live recency.

### Idempotency and re-runs

Idempotency is keyed on `(tree, name)`. Docs are submitted with `onConflict: "replace"` and deterministic meta, so re-runs reconcile in place: an unchanged file is a no-op, an edited file updates its row, and an importer-version bump re-renders everything. The walk is sorted, so name disambiguation (`-2`, `-3` suffixes on collisions) is stable across runs. A file **deleted** (or renamed) in the source leaves its old row behind — nothing is pruned unless you ask.

### Pruning (deletions and renames)

`--prune` reconciles deletions in **one atomic server-side pass** (`memory.reconcileTree`): every row under the docs root that carries the importer's stamp (`meta.source: "docs"` — rows this importer didn't write are never touched, so a manual note under the same tree is safe) and whose `(tree, name)` slot this walk didn't produce is deleted in a single set-based statement — complete at any corpus size, with no enumerate/delete race. `--dry-run --prune` runs the same predicate as a read and returns the **exact** would-delete list. The everyday reason to run it is **renames**: a renamed file gets a fresh `(tree, name)` slot, and without pruning the old slot lingers as a stale duplicate.

> **Prune means "everything under the docs root not in *this* walk".** A narrowed invocation — a subdirectory argument, or `--include`/`--exclude` filters — makes the walk a slice, and pruning against a slice deletes the rest of the corpus. Only combine `--prune` with a full-corpus run (same `dir`, same filters as the original import), and preview with `--dry-run --prune` when unsure. Prune either reconciles completely or **refuses cleanly with nothing deleted** (exit 1): on an empty walk (a wrong cwd must not read as "delete everything"), and when the walked slot list is too large for a single reconcile request (roughly 20k docs — the keep-list cannot be split across requests).

### Metadata

| Key | Description |
|-----|-------------|
| `title` | Frontmatter `title:`, else first `# H1`, else the filename — human-readable, emoji/punctuation intact. |
| `source` | Always `"docs"`. |
| `repo_path` | The file's path relative to the import root (posix separators). |
| `doc` | The parsed frontmatter object, verbatim (absent when the file has none). |
| `truncated` | `true` when the content hit the 64 KiB cap (absent otherwise). |
| `importer_version` | Version tag of the importer schema. |

### Example

```bash
me import docs --dry-run -v            # preview from the repo root
me import docs                          # import into <project-tree>/docs
me import docs docs/ --include '**/*.md'   # just one folder, .md only
me import docs . --temporal-key date    # blog/ADR repos with date: frontmatter
me import docs --prune --dry-run        # preview a full-corpus reconcile
me import docs --prune                  # re-sync, deleting removed/renamed docs
me memory tree ~/projects/acme/docs --levels 3   # browse the result
```

---

## me import slab

Import a [Slab](https://slab.com/) knowledge-base export — markdown posts laid out in topic folders — as one memory per post. Slab's topic hierarchy becomes the tree path, so the whole wiki is browsable (`me memory tree`) and searchable (hybrid BM25 + semantic) in one space.

The source is a Slab export: nested folders of `.md` files (one per post, mirroring Slab's topic hierarchy), with no per-file frontmatter. Unlike [`me import memories`](#me-import-memories) (which needs frontmatter and otherwise flattens everything into `share`), this command derives the tree, name, title, and temporal from the filesystem layout itself.

The source may be either an already-unzipped **directory** or the raw **`.zip`** export — a zip is detected by its contents (not just the `.zip` extension), extracted into a temporary directory (only `.md` entries; auto-removed when the import finishes), and imported exactly like a directory. If the zip wraps everything in a single top-level folder, that wrapper is stripped so topics still map directly under the tree root.

```
me import slab <source> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `source` | yes | Path to the Slab export — a directory, or a `.zip` file. |

| Option | Description |
|--------|-------------|
| `--tree-root <path>` | Tree root under which the topic hierarchy is placed. Default: `/share/slab`. |
| `--uncategorized-node <name>` | Bucket label for topic-less posts at the export root (an ltree label, `[a-z0-9_]+`). Default: `uncategorized`. |
| `--no-temporal` | Do not derive a memory temporal from a leading date in the filename. |
| `--dry-run` | Parse and report what would be imported without writing. |
| `-v, --verbose` | Per-file progress output (prints each `tree / name`). |

### Tree layout

Each post is a named leaf under its slugified topic path:

```
<tree-root>/<topic>/<subtopic>/.../<post-name>
```

Every directory segment is normalized to an ltree label (lowercase, non-alphanumeric runs collapsed to `_`, e.g. `Customer Success/SOPs & Playbooks` → `customer_success/sops_playbooks`), and the leaf name is a filename-derived slug that keeps its `.md` extension, unique within its tree. Posts sitting loose at the export root (no topic folder) go under `<tree-root>/<uncategorized-node>`. A post is then addressable by path, e.g. `me memory get "/share/slab/customer_success/sops_playbooks/cloud-faq.md"`.

### Content shape

Each memory's content is the post's full markdown body, trimmed of leading/trailing whitespace (image links and `slab.com` URLs preserved as-is). The title is the post's first `# H1` heading, or the filename when there is none; it is stored in `meta.title` (the human-readable form, with punctuation and emoji intact that the ltree slug drops).

> **Images are not rehosted.** Image links in a post are kept exactly as they appear in the export — they still point at Slab-hosted (or otherwise external) URLs. The import copies no image bytes, so an embedded image renders only while its original URL is reachable; if the source becomes unavailable or its links expire, those images will break. The surrounding markdown text is unaffected.

### Idempotency

Idempotency is keyed on `(tree, name)`. Posts are submitted with `onConflict: "replace"` and a deterministic `meta.importer_version`, so a re-import is a no-op when nothing changed, and bumping the importer version re-renders every post in place. The walk is sorted, so name disambiguation (`-2`, `-3` suffixes on any slug collision within a folder) is stable across runs. A post whose filename starts with a date seeds a date-prefixed UUIDv7 id so it sorts chronologically by id; undated posts get a server-generated id.

### Metadata

| Key | Description |
|-----|-------------|
| `title` | Post title (first H1, else filename) — human-readable, emoji/punctuation intact. |
| `source` | Always `"slab"`. |
| `slab_topic_path` | Original (un-slugified) topic folder path, e.g. `Customer Success/SOPs & Playbooks`. |
| `original_filename` | The post's source `.md` filename. |
| `importer_version` | Version tag of the importer schema. |

Temporal is a point-in-time parsed from a leading `YYYY-MM-DD`, `YYYY.MM.DD`, or `YYYYMMDD` date in the filename (e.g. weekly updates), or absent when the filename carries no valid date. `--no-temporal` disables this.

### Example

```bash
me import slab ./export.zip --dry-run -v   # preview straight from the zip
me import slab ./export.zip                 # extract + import under /share/slab
me import slab ./data                       # or from an already-unzipped dir
me memory tree /share/slab --levels 2       # browse the reconstructed topics
```

Everything lands under one tree root, so the import is reversible — `me memory deltree /share/slab` removes it cleanly.

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

The hook lives in `.git/hooks` — per clone, never committed, never pushed. CI checkouts and teammates' clones are unaffected; each clone opts in by running `me import git-hook` itself ([`me project init`](me-project.md) offers it as a setup step).

The import is deliberately silent and best-effort: it never blocks or fails a commit, which also means auth or connectivity problems won't surface at commit time. If history seems stale, run `me import git` manually to see the error — the next successful fire catches everything up.
