# me project

Harness-agnostic per-project setup. For guidance on choosing between
team-writable layouts such as `/share/projects/<project>`, group-writable layouts
such as `/share/<group>/<project>`, and private group layouts outside `/share`,
see [Projects](../projects.md).

## Commands

- [me project init](#me-project-init) -- configure this project's memory: space, location, agent, and the setup checklist
- [me project ci](#me-project-ci) -- set up the GitHub Actions import workflow (scaffold + service-account credentials)

---

## me project init

Set up the current project's Memory Engine integration. Interactively it runs a wizard and then a setup checklist; non-interactively (piped / scripted) it runs just the checklist, honoring the `--skip-*` flags.

```
me project init [options]
```

No plugin is installed per project: a single user-scoped install per harness ([`me claude install`](me-claude.md#me-claude-install) / [`me opencode install`](me-opencode.md#me-opencode-install), each run once) picks the configuration up from the committed `.me/config.yaml` this wizard writes. Teammates who have already installed their harness get the project's behavior just by cloning — no per-repo install.

### Preflight

Before any question, the wizard checks two prerequisites and offers to fix each:

- **Not logged in** → offers to run `me login`. A session is required (the wizard lists your spaces and creates agents), so **declining stops**.
- **No harness set up yet at all** → a multiselect offering to set up every harness detected as installed on this machine but not yet configured (today: Claude Code, OpenCode). Selecting one runs its install flow ([`me claude install`](me-claude.md#me-claude-install) / [`me opencode install`](me-opencode.md#me-opencode-install), always at OpenCode's default **user** scope here — run the standalone command yourself with `--scope project` if you want a team-committed OpenCode setup instead), which itself pins global defaults and asks about capture. Not required to write the config, so **declining any of them continues with a warning**. Once **any** harness is already set up, this whole step is skipped silently — per-project init doesn't nag about additional harnesses you may not use.

When logged in and at least one harness is already set up, preflight is silent.

### 0. Space

Pick which space this project's memories live in — the list of spaces you belong to (defaulting to your active space), or **create a new space** (you become its admin/owner, and it becomes your active space). The chosen space is written as `space:` in `.me/config.yaml` together with `server:` (a space lives on one server, so a committed config resolves the same for every teammate).

### 1. Where should this project's memories live?

One choice combining visibility with the tree root — `<slug>` is derived from the project (git `origin` repo name → git root directory name → directory basename):

- **`/share/projects/<slug>`** (default) — public: shared with the whole team.
- **`~/projects/<slug>`** — private: your own home tree, visible only to you.
- **(custom)** — type any tree root.

Written as `tree:` in `.me/config.yaml`; captures and imports nest under it (`<tree>/agent_sessions`, `<tree>/git_history` — no slug appended).

In a default space, `/share/projects/<slug>` is writable by the default `team`
group. Use a custom tree such as `/share/payments/<slug>` when the team should
read but only a subgroup should write; use a path outside `/share` when the
project should not be broadly readable. Grant the target group write access
before or after running the wizard. Creating groups is space-admin-only;
granting access requires owner access at the target path, so you may need help
from a space admin or path owner for these patterns.

### 2. Agent

The wizard always sets the project up with a dedicated agent (there's no "run as my own user" option here — though the `agent` field itself is optional in the config schema):

- **Create a new agent with access to the whole space** (default) — created, added to the space, and granted **write** at the space root. The server clamps an agent to `least(agent, owner)` per path, so a root grant gives it exactly what you can reach — never more.
- **Create a new agent with access to only this project** — same, but the write grant lands on the step-1 tree.
- **Use an existing agent** — pick one of your agents already in the chosen space; its existing grants apply unchanged. (Hidden when you have none there.)

New-agent names prefill `<slug>-agent`, bumped to a free variant. The agent's name is written as `agent:` in `.me/config.yaml` — every harness surface (MCP, the capture hooks, a plain `me` call from an agent's own shell) resolves and acts as this agent automatically, no separate settings pin needed (see [Agent-by-config](../project-config.md#agent-by-config-and-the-agent-field)). If an older `me project init` had pinned a literal `ME_AS_AGENT=<name>` into the project's `.claude/settings.json`, this run removes it — a leftover value there would otherwise silently override the injected `.me` sentinel.

> **Team caveat**: `agent:` resolves only against the caller's **own** agents, so a committed `agent:` works for the teammate who created it. Other teammates should run `me project init` themselves (choosing "use an existing agent" or creating their own).

### 3. Setup checklist

A grouped multiselect, everything pre-checked (non-interactive runs execute all of it minus the `--skip-*` flags). The transcript-import and memory-pointer rows are **harness-gated** — hidden automatically when they don't apply, rather than always assuming Claude:

| Group | Step | Skip flag | What it does |
|-------|------|-----------|--------------|
| Claude Code sessions | Import this project's existing Claude Code sessions (one-time backfill) | `--skip-transcript-import-claude` | Backfills sessions recorded in this repo. Reads the just-written `.me` `tree`, so the backfill lands exactly where live capture writes. **Hidden** when this project has no Claude Code sessions at all. |
| Codex sessions | Import this project's existing Codex sessions (one-time backfill) | `--skip-transcript-import-codex` | Same, for Codex. **Hidden** when this project has no Codex sessions. |
| OpenCode sessions | Import this project's existing OpenCode sessions (one-time backfill) | `--skip-transcript-import-opencode` | Same, for OpenCode. **Hidden** when this project has no OpenCode sessions. |
| Session capture | Enable ongoing capture of new agent sessions | `--skip-capture-enable` | Writes `capture: true` to `.me/config.yaml` — the committed, per-project capture opt-in every installed harness's hooks honor (it wins over each member's global setting). One flag covers every harness; interactively **deselecting** this row writes an explicit `capture: false`, so the committed config is deterministic for the team; non-interactively, `--skip-capture-enable` just leaves the file untouched. |
| CI import | Set up the GitHub Actions import workflow | `--skip-ci-workflow` | Runs [`me project ci`](#me-project-ci): scaffolds `.github/workflows/me-import.yml` and walks through service-account credentials. Imports (git history + docs) then run in CI on push to the default branch — the first run backfills the full history, so there is no local backfill step. **Hidden** outside a git repo or without a GitHub remote. A pending end-state (e.g. "ask your space admin") never aborts the rest of init. |
| Project config | Add a memory pointer to CLAUDE.md | `--skip-claude-md` | Upserts a managed block naming the project tree and how to search it. **Hidden** unless Claude Code is installed on this machine. |
| Project config | Add a memory pointer to AGENTS.md | `--skip-agents-md` | Same, for `AGENTS.md` — the convention OpenCode and Codex both read. **Hidden** unless OpenCode or Codex is installed on this machine. |

Steps already done are offered unchecked as idempotent re-runs (non-interactive runs report them as ✓ lines and skip them). Re-running `me project init` is safe throughout: the imports are incremental/idempotent and the config writes preserve comments.

### Example: the default flow

Already logged in, plugin installed, running in `~/dev/acme-api` (a git repo): preflight is silent and the happy path is five enters — active space, public location, a whole-space agent, its pre-filled name, run everything. Result:

```yaml
# .me/config.yaml (committed)
server: https://api.memory.build
space: acme-eng
tree: /share/projects/acme-api
agent: acme-api-agent
capture: true
```

plus the session backfills, the CI import workflow, and the CLAUDE.md pointer.

### Deprecated aliases

`me claude init` and `me opencode init` both now print a rename notice and run this command; the aliases will be removed in a future release.

---

## me project ci

Set up (and maintain) the GitHub Actions workflow that imports this repo's git history and docs into Memory Engine on every push to the default branch. The workflow calls [`me import ci`](me-import.md#me-import-ci); this command owns everything around it: the workflow file, the service-account identity, and the key-in-a-secret.

```
me project ci [--create-service-account] [--service-account <name>]
              [--key-name <secret-name>] [--workflow-only]
              [--rotate-key] [--dry-run]
```

Interactive on a TTY (prompts stand in for the flags); the flags are the headless spellings. Requires a committed `.me/config.yaml` pinning `space` and a **shared** (non-`~`) `tree` — the CI run authenticates as a service account, which has no home tree. Run [`me project init`](#me-project-init) first.

| Option | Description |
|--------|-------------|
| `--create-service-account` | Provision repo-scoped credentials without prompting. Provisioning is **never** implicit — a missing secret alone only errors with the options. |
| `--service-account <name>` | The service account expected to hold the CI credentials. Default: the committed `import.service_account`, else `<repo>-import`. |
| `--key-name <secret-name>` | The GitHub secret's name (default `ME_API_KEY`). Baked into the workflow as `ME_API_KEY: ${{ secrets.<name> }}` — the env var `me` reads never changes — and recovered from the managed workflow on later runs. For orgs whose repos span multiple spaces (one org secret per space, distinct names). |
| `--workflow-only` | Write/update the workflow file and stop — `gh` is never invoked and secrets are never checked or touched. For credentials managed elsewhere: Terraform/UI-managed secrets, an org whose admin already provisioned everything, or a dev whose `gh` can't read this repo's secrets. Composes with `--key-name`; rejected with the credential flags. |
| `--rotate-key` | Mint a new key for the (existing) service account and update the secret. Self-serve for the account's bound admin group. |
| `--dry-run` | Report what would happen without writing anything. |

### What it does

1. **Workflow** — writes/updates `.github/workflows/me-import.yml` with managed-file semantics: a marker line identifies the scaffold; a hand-maintained file is never silently overwritten. The scaffold is **repo-agnostic** — the default branch is discovered at runtime by the workflow's own job gate (`github.event.repository.default_branch`), so it survives branch renames and an org can distribute the identical file to every repo.
2. **Secret check** — is a secret named `<key-name>` already available to the repo? Checked via `gh`: repo secrets plus org-provided secrets (the org-secret setup, where an org admin provisions one shared service account + one org secret and per-repo setup collapses to the scaffold). GitHub secrets are write-only, so presence is the only signal — the contents are verified end-to-end by the first workflow run, which fails loudly if the key or grants are wrong.
3. **Identity + key** (only when provisioning — explicit flag or interactive yes): ensure the service account exists (creating it with **you seeded into its bound admin group**, so rotation stays self-serve), ensure a **write** grant at the project tree, then mint a key **directly into** `gh secret set` — a key is minted only when it has an immediate destination, and is never displayed or stored. Without `gh` — or when the repo's secrets couldn't be *read* (writing them needs the same repo-admin access, so a direct mint would fail at placement) — nothing is minted; the exact commands to run together are printed instead. If placement ever fails after a mint, the just-minted key is revoked on the spot, so no orphan credential is left behind.

With the secret present and an identity named (`--service-account` or the committed `import.service_account`), the run instead **verifies**: the account exists and holds write at the project tree (a missing grant is offered/applied; a missing account is a hard inconsistency error pointing at `--create-service-account`).

### When creation is denied (you're not a space admin)

Creating a service account requires a space admin — the expected common case for a repo dev. The denial is not a dead end: the error names the space's admins (with emails) and the exact two commands to ask one of them to run:

```
me service create <repo>-import --admin you@example.com
me access grant write /share/projects/<repo> <repo>-import
```

`--admin you@…` puts you in the account's bound admin group, so after re-running `me project ci`, key minting and future rotation are yours — no further admin involvement.

### Migration from the retired git hook

A post-commit hook installed by the removed [`me import git-hook`](me-import.md#me-import-git-hook-removed) keeps firing on every commit until its block is removed. `me project ci` detects the block and strips it **once CI credentials are in place** (never earlier — that would open a gap between "hook gone" and "CI not yet importing").
