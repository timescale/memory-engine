# CI Import Design (TNT-208 + TNT-209)

**Status: draft for review.** Service accounts (PR #147) are **merged**
(2026-07-10, in the v0.5.0 line), so both tickets' "might depend on #147"
dependency is discharged — this design builds on the shipped `me service` /
`me apikey --service` surface directly.

One design for both tickets:

- **TNT-208** — replace the `me project init` git post-commit hook with a
  GitHub-workflow-based import (the hook imports commits not merged to main).
- **TNT-209** — make it easy to keep docs in Memory Engine up to date when doc
  changes merge to main (`me import docs` from CI).

They are the same problem: **a shared project tree should be updated at the
moment content becomes canonical — on push to the default branch — by a
team-owned identity, not per-clone/per-person side effects.** So this proposes
one workflow, one CLI entrypoint, one identity, covering both git history and
docs.

## 1. Problems with the status quo

The post-commit hook (`me import git-hook`, installed by `me project init`):

1. **Imports unmerged work.** It fires on every local commit and walks HEAD, so
   feature-branch commits land in the tree keyed by `(tree, sha)` forever.
   Rebases re-import the same work under new shas, leaving orphans. A shared
   project tree ends up describing histories that never existed on main.
2. **Per-clone, per-person.** `.git/hooks` is never committed, so the hook runs
   only on machines where init was run. Coverage of a team repo is whoever
   happened to install it.
3. **Runs as the user.** `me import git` is a plain CLI command (not a harness
   surface), so the hook fires with the committing human's credentials. Every
   committer needs write at the shared tree, and attribution is whoever's
   machine fired last.
4. **Silently best-effort.** By design the hook never fails the commit — which
   also means auth/config breakage is invisible indefinitely.

Docs have no ongoing story at all: `me import docs` is a manual command.

## 2. Goals / non-goals

Goals:

- Shared project trees reflect **merged state only**: main's first-parent
  history and main's docs corpus.
- **Team-owned identity**: the import survives any individual leaving
  (service accounts, PR #147).
- **Zero-maintenance repos**: the committed workflow is a thin shim; behavior
  ships in the CLI, config lives in `.me/config.yaml`. A repo shouldn't need to
  edit YAML when the importers improve.
- **Idempotent and self-healing**: any single run catches up the full backlog;
  a missed run costs nothing (this already holds — `(tree, name)` keys,
  `onConflict: "replace"`, server-side high-water).
- Local **preview parity**: a developer can run the exact CI entrypoint with
  `--dry-run` and see what CI would do.

Non-goals (for this milestone):

- Non-GitHub CI packaging (the CLI entrypoint is CI-agnostic; GitLab/Jenkins
  templates can come later — "github actions for now" per TNT-209).
- Cleaning up hook-era pollution already in shared trees (follow-up, §10).
- PR-preview imports, docs versioning, or importing anything at PR time.
  Fork-PR contexts don't get secrets and unmerged content is exactly what we
  are removing.

## 3. Architecture: three layers

```
┌─────────────────────────────────────────────────────────────┐
│ .github/workflows/me-import.yml   (committed, scaffolded,   │
│   ~15 lines, essentially frozen)                             │
│     └─ curl install me → `me import ci`                      │
├─────────────────────────────────────────────────────────────┤
│ `me import ci`                    (new CLI command — the     │
│   orchestrator: git + docs with CI defaults, config-driven) │
├─────────────────────────────────────────────────────────────┤
│ `me import git` / `me import docs`  (existing primitives,   │
│   unchanged semantics)                                       │
└─────────────────────────────────────────────────────────────┘
```

All real logic lives in the CLI (same philosophy as the harness design: dumb
shims in the host system, behavior in `me`). The workflow YAML is deliberately
too small to need maintenance. Anyone on a different CI system calls
`me import ci` themselves.

## 4. Identity: a service account per repo

The importer runs as a **service account** (`kind='s'`, merged in PR #147) —
this is literally Example 2 in `SERVICE_ACCOUNTS.md` ("docs/commits import
GitHub Action"). Rationale over the alternatives:

- **User PAT**: breaks when that person leaves; attributes team content to one
  human; over-privileged (a PAT is the whole user).
- **Agent key**: owned by one human (same leaving problem) and owner-clamped —
  the import silently loses access if the owner's grants change.
- **Service account**: team-administered via its bound admin group, no owner
  clamp, starts inert, granted exactly `write@<project tree>`.

Setup (driven by `me project ci`, standalone or as an init step — §7), using
the shipped surface:

1. `me service create <repo>-import --admin <team member(s)>` (space admin;
   `--admin` seeds the bound admin group so key rotation isn't tied to the
   creator).
2. Grant **write** at the project tree from `.me/config.yaml`:
   `me access grant write /share/projects/<slug> <repo>-import`. Service
   accounts start inert (no home grant, no default group), so this one grant
   is their entire access. Write (level 2) covers
   create/replace/delete-orphans and includes read, which the git importer's
   high-water search needs. Least privilege: grant at the project node, never
   at `/share` root.
3. `me apikey create --service <repo>-import ci-import` — printed once; place
   it in the repo secret `ME_API_KEY` (offer to run `gh secret set ME_API_KEY`
   when `gh` is authenticated). Minting requires a session, so this step is
   inherently interactive — which is fine, init is interactive.

Rotation/revocation is self-serve for the bound admin group
(`me apikey create/delete --service …` + `gh secret set`), with no dependency
on the original creator.

### Authority failures name the admins

Steps 1–3 are authority-gated (SA create/delete: space admin; key mint: the
bound admin group or a space admin; the grant: owner at the path), and the
common `me project ci` runner is a repo dev with none of those — so the
default outcome of provisioning is a denial. Today that's a dead end: a
non-admin can't even discover whom to ask (`principal.list` is admin-only;
`principal.resolve` is targeted lookup, not enumeration).

Fix, server-side: when a space-management operation fails on authority, the
server enriches the FORBIDDEN error's `data` with the space's **effective
admins** — the same predicate `enforce_last_admin` uses (direct-member users
who are direct admins or direct members of an admin group) — as
`{name, email}` pairs (email joined from `auth.users` via the shared
principal id). No new query surface and no caller authority involved: the
server computes it itself, only on a denied attempt, only for space members
(non-members never get past the auth gate). Exposing admins-to-members is
deliberate and bounded — it's "contact your admin", not roster enumeration.

The CLI then renders the denial as an escalation path, including the
copy-paste command for the admin to run:

```
Creating a service account requires a space admin.
Space admins for acme-eng: Alice Chen <alice@acme.dev>, Bob Ito <bob@acme.dev>
Ask one of them to run:
  me service create repo-import --admin you@acme.dev
  me access grant write /share/projects/repo repo-import
Then re-run this command — with you in the bound admin group, key
management is self-serve from here.
```

This lands on every admin-gated surface for free (`me service create`,
`me apikey create --service`, `me access grant`, …), not just `me project
ci`.

### Org-level variant: one service account, one GitHub org secret

Per-repo SA + repo secret is the default, but orgs onboarding many repos will
want to pay the setup cost once. The pieces already compose:

- **One shared SA per space** (SAs are space-scoped by construction — created
  in, and deleted from, exactly one space), e.g. `github-import`, with the
  platform team as its bound admin group.
- **One grant at the common parent** of the org's project trees — ltree
  grants make `write@/share/projects` cover every current *and future* repo
  tree under it. Orgs wanting a tighter blast radius instead grant per
  project tree as repos onboard (the shared key then still leaks less than it
  could reach).
- **One key → a GitHub org secret** `ME_API_KEY`, visibility scoped to
  selected repos (or all). Rotation is one `me apikey create --service` +
  one org-secret update, org-wide.
- **Per repo, setup collapses to the workflow scaffold**: `me project ci`
  sees the secret already available and skips identity/key phases. For this
  to work, the phase-3 "secret present?" check must consider org-provided
  secrets too — `gh secret list` alone shows repo secrets; the repo's
  visible org secrets come from the
  `/repos/{owner}/{repo}/actions/organization-secrets` API (via `gh api`).
  And since the scaffold contains no repo-specific values (§5, §7), the org
  can even skip `me project ci` and distribute the identical workflow file
  itself — commit it via an org-wide PR sweep or a `.github`
  workflow-template.
- The CLI can't read a secret's value, so it can't verify that an inherited
  org secret actually holds a working key with the right grants — the first
  workflow run is the verification, and it fails loudly by design (§5).
- With a **parent-level grant**, that's the whole per-repo story: no flags,
  no SA name needed — the repo dev never has to know the shared SA exists.
  With **per-project grants**, each onboarding must extend the shared SA's
  grant to the new repo's tree, so the SA must be named: commit
  `import.service_account: <name>` in the org's `.me/config.yaml` template
  (§6) and plain `me project ci` verifies/extends automatically;
  `--service-account <name>` is the ad-hoc override (§7).

Caveats: a multi-space org needs one SA + key per space; since an org secret
has a single value, each space's org secret gets its own name and repos
scaffold with `me project ci --key-name <that name>` (§7 — the workflow maps
it onto the `ME_API_KEY` env var `me` reads). Plain per-repo secrets also
still work (a repo secret shadows an org secret of the same name, so mixed
setups degrade gracefully).
Attribution is unaffected either way — repo provenance lives in each memory's
meta (`source_project_slug`, `source_git_repo`); the SA is only the authz
identity.

Server/space/tree resolution needs nothing new: the committed `.me/config.yaml`
already pins them, and `ME_API_KEY` is a global credential admitted per-space
via `X-Me-Space`. The **trusted-server gate** on `.me`-pinned servers is
satisfied for prod/dev (both in `DEFAULT_TRUSTED_SERVERS`); a self-hosted
server sets `ME_SERVER` in the workflow env instead (env is precedence-above
`.me` and deliberately ungated — in CI the secret is repo-scoped, and anyone
who can edit `.me` can edit the workflow, so the gate protects nothing there).

## 5. The workflow (scaffolded by `me project ci`)

```yaml
name: Memory Engine import
on:
  push:                    # all branches — the job gates on the default branch
  workflow_dispatch: {}    # manual backfill / re-run

concurrency:
  group: me-import
  cancel-in-progress: true # newest run supersedes: every run is a full catch-up

jobs:
  import:
    # Auto-discovers the default branch at runtime — survives a rename, and
    # keeps this file identical across every repo (no scaffold-time values).
    if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0   # REQUIRED — see below
      - name: Install me
        run: curl -fsSL https://install.memory.build | sh
      - name: Import
        env:
          ME_API_KEY: ${{ secrets.ME_API_KEY }}  # secret name: --key-name (§7)
        run: ~/.local/bin/me import ci
```

Design points:

- **Default branch only, discovered at runtime.** GitHub has no native
  "default branch" push filter (`$default-branch` works only in workflow
  templates), so the choice is scaffold-time substitution vs a runtime gate.
  Substitution rots silently: rename the default branch and the filter stops
  matching — imports just stop, invisibly. The job-level `if` on
  `github.event.repository.default_branch` survives renames and makes the
  file repo-agnostic (identical across an org). Cost: pushes to other
  branches create skipped runs in the Actions tab — noise, but free (skipped
  jobs consume no runner minutes), and honest. Never `pull_request` (secrets
  aren't available to fork PRs, and PR content is exactly what we're
  excluding). `workflow_dispatch` gives a manual backfill/retry button — the
  same gate applies, so dispatch runs only from the default branch.
- **`fetch-depth: 0` is required, not an optimization.** Shallow clones break
  both importers in ways worse than slowness: the git walk can't see history
  past the shallow boundary (dangling `$prev`, broken `isAncestor` high-water
  checks), and the docs importer drops git last-modified temporals on shallow
  repos — which would make each doc's temporal flap between full and shallow
  runs, defeating replace-no-op idempotency. Deterministic inputs or nothing.
- **`cancel-in-progress: true`**: runs are stateless and any run catches up
  everything, so the newest run strictly supersedes a running older one.
  Cancellation mid-import is safe (idempotent replace; the docs prune is a
  single atomic call).
- **Loud failure.** Unlike the hook, this fails the workflow on any error —
  auth rot, revoked grants, bad config become a red build, not silence.
- **No pinned `me` version at launch.** The CLI is young and importer fixes
  should propagate without editing N repos. Trade-off noted in §11; the
  installer can grow a version-pin flag when stability matters more than
  freshness.

## 6. `me import ci` — the orchestrator command

A new command that runs the project's configured imports with CI-appropriate
defaults, from the repo toplevel:

```
me import ci [--dry-run] [-v]
```

Behavior:

1. Resolve project config (`discoverProjectConfig` — same path every importer
   uses). Require a git work tree; run from its toplevel regardless of cwd.
2. **Git**: `me import git` semantics on HEAD (in CI, the pushed default-branch
   commit). Incremental high-water as today; first run = full-history backfill
   of main's ancestry — so **initial backfill is automatic**, no local
   backfill step needed.
3. **Docs**: `me import docs` semantics from the repo toplevel with the default
   globs (`**/*.md`, `**/*.markdown`, `**/*.mdx`) and **prune on**. CI is the
   authoritative full-corpus walk, so pruning deleted/renamed docs is correct
   here (and the existing empty-walk refusal still guards catastrophe). A repo
   with zero matching files **skips** the docs phase cleanly rather than
   failing.
4. Print a compact summary per phase (imported/updated/skipped/pruned counts)
   sized for CI logs; exit non-zero if any phase errs.

Configuration lives in `.me/config.yaml` (strict schema gains one optional
block), not in workflow flags — single source of truth, and `me import ci
--dry-run` locally previews exactly what CI will do:

```yaml
server: https://api.memory.build
space: abc123def456
tree: /share/projects/memory_engine
import:
  git: true                    # default true
  docs: true                   # default true
  docs_include: ["docs/**"]    # optional; default = all markdown in the repo
  docs_exclude: []             # optional
  service_account: github-import  # optional; the SA expected to run the imports
```

`import.service_account` is read by `me project ci`, not by `me import ci` —
it names the identity the CI credentials are supposed to hold, so
setup/verify works without a flag (see §7; the name is not a secret — any
space member can resolve it). Committing it makes an org's per-project-grant
setup self-documenting.

(No `docs_prune` knob at launch: prune-on is the point of an authoritative CI
walk. Add the escape hatch only if someone needs it.)

**Determinism rule**: `me import ci` must not stamp per-run metadata (run id,
timestamps, actor) into memories — the replace-no-op idempotency of both
importers depends on deterministic meta. Attribution is the service-account
identity server-side, not meta.

**Not a harness surface**: like `me import git` today, this is a plain CLI
command — no agent-by-config resolution, no `--as-agent` needed. The bearer is
the service-account key from `ME_API_KEY`. (The harness failsafe doesn't
trigger: GitHub Actions isn't an AI harness, and an explicit api-key bearer is
exempt regardless. An implementation test should pin this.)

## 7. `me project init` changes

Setup ships as a standalone command, **`me project ci`**, with the init step
as a thin wrapper — the same shape as every other init step (init steps wrap
standalone commands: `git-import` wrapped `me import git`, harness steps wrap
`me <harness> install`). Init covers first-time setup; the standalone command
covers everything after it: key rotation, re-scaffolding when the template
changes, and adding CI to a project that ran init before this feature existed.

```
me project ci [--create-service-account] [--service-account <name>]
              [--key-name <secret-name>] [--rotate-key] [--dry-run]
```

Like init, the command is **interactive on a TTY**: prompts stand in for the
flags — the provisioning gate below becomes a yes/no with the org-secret
alternative spelled out, and the SA name is prompted with `<repo>-import`
prefilled. The flags are the non-interactive spellings for scripts and docs;
a headless run without them gets the errors described below.

The target service account resolves as `--service-account` flag > `.me`
`import.service_account` > `<repo>-import`. An identity is only *required*
when one is acted on — provisioning (`--create-service-account`) or rotation
(`--rotate-key`); verification runs when a name was given explicitly (flag or
config) and is skipped otherwise, because with a parent-level org grant there
is nothing repo-specific to check and the repo dev needn't know the SA's name
(§4 org variant).

`--key-name` names the **GitHub secret** (default `ME_API_KEY`). It is baked
into the scaffolded workflow as `ME_API_KEY: ${{ secrets.<key-name> }}` — the
env var `me` reads never changes, only the secret feeding it — and later runs
recover the name from the managed workflow block, so it's passed once at
scaffold time. The presence check and `gh secret set` both target it. Primary
use: multi-space orgs, where differently-named org secrets must coexist (§4
caveats).

Idempotent. The **workflow phase** always runs: write/update
`.github/workflows/me-import.yml`, with managed-file semantics like the old
hook installer — update our scaffold in place, never silently clobber a
hand-edited workflow (offer a diff/skip). The scaffold carries no
repo-specific values (the default branch is discovered at runtime, §5); the
only variable content is `--key-name` and, for a non-default pinned server,
a baked-in `ME_SERVER` env.

The **identity and key phases** pivot on one question: *is the configured
secret (default `ME_API_KEY`, see `--key-name`) already available to the
repo?* (repo-level via `gh secret list`, org-provided via the repo's
organization-secrets API — §4 org variant). That presence check is the only
signal GitHub offers — secrets are **write-only**, so the CLI can never learn
which principal's key a present secret holds. And because the check can't
distinguish "solo repo, nothing set up yet" from "org repo whose org-secret
visibility list is missing this repo", **provisioning is never implicit**:
creating an SA / minting a key happens only under an explicit
`--create-service-account` or an interactive yes on a TTY, never as the
fallback of a failed check.

- **Secret present, no flags**: credentials are someone's solved problem — a
  previous provisioning run's repo secret, or an org admin's org secret.
  Report "using existing secret" and stop. When an identity IS named
  (`--service-account` or `.me` `import.service_account`), run **verify
  mode** against it: exists + grant present → report OK; exists but no write
  at this project's tree → offer/apply the grant (safe: it's the operator's
  stated intent and touches no secret); **doesn't exist → error** — a
  present secret can't be holding a nonexistent SA's key, and the error
  points at `--create-service-account` as the one consistent repair. Verify
  mode proves only the memory-engine side — it can never confirm the
  write-only secret actually holds the named SA's key;
  `--create-service-account` / `--rotate-key` are how you force provable
  consistency.
- **Secret absent, not provisioning**: on a TTY, prompt — provision
  repo-scoped credentials now, or stop because an org secret was expected.
  Headless (no `--create-service-account`): **error**, naming the same two
  resolutions: ask the org admin to add this repo to the org secret's
  visibility list (§4 org variant), or re-run with
  `--create-service-account`. The init wizard inherits the TTY behavior.
- **`--create-service-account`** (or the TTY yes) — the only provisioning
  path: ensure the resolved SA exists (creating it if needed), ensure write
  at the project tree (§4 walkthrough; requires a session + the relevant
  authority to create/grant), then handle the key — with one rule: **a key
  is minted only when it has an immediate destination.** With `gh`
  available and the secret-set confirmed, mint (`me apikey create
  --service`) and pipe straight into `gh secret set <key-name>` — the key
  is never displayed or stored. Without `gh` (or on a decline), mint
  nothing; print the mint + set commands for the operator to run together.
  This avoids orphan credentials: a minted-but-unplaced key is live in
  terminal scrollback with no home and only manual revocation to clean it
  up. (`--rotate-key` follows the same rule.) If a secret is already
  visible to the repo, provisioning warns that the new repo-level secret
  will shadow it and asks for confirmation. An authority denial here is the expected common case
  (most repo devs aren't space admins) and isn't a dead end: the enriched
  error renders the space admins' names + emails and the exact commands to
  ask them to run (§4 "Authority failures name the admins").
- **`--rotate-key`** — rotation for an existing setup: mint a new key for the
  resolved SA and update the secret; the SA must already exist (the error
  points at `--create-service-account`). Revoking the old key is printed as
  the follow-up.

The "Git history" step group becomes a "CI import" group:

- **`ci-workflow` step** (offered when the repo has a GitHub remote and a
  shared `.me/config.yaml` tree): runs `me project ci`.
- **`me import git-hook` is removed entirely** — the command, the init step,
  and its `docs/cli/me-import.md` section. Even in a private tree the hook
  imports rebased/unmerged commits (permanent `(tree, sha)` orphans) and rots
  silently; keeping it documented invites exactly the misuse TNT-208 is
  about. It becomes a `createRemovedCommand` stub (the existing retired-
  command pattern, cf. `me claude init`) whose error points at `me project
  init`. Anyone who truly wants local-commit capture can put the one-liner
  `me import git >/dev/null 2>&1 &` in their own hook — the primitive stays.
- **Migration**: already-installed hooks keep firing on every commit until
  their managed block is deleted, and the `--remove` path is gone with the
  command — so cleanup moves into `me project ci` (and thus init, via the
  step): it detects the managed block in `.git/hooks/post-commit` by its
  `>>> memory-engine` markers and offers to strip it (a small retained helper
  from `import-git-hook.ts`; the rest of that file is deleted). The
  removed-command stub's message names the same two options: run
  `me project ci`, or delete the block by hand.
- **`git-import` (local backfill) step: removed** for the CI path — the first
  workflow run backfills main's full history under the service account, which
  is better attribution than a one-time user-credential backfill. (It remains
  reachable as plain `me import git` for private/non-GitHub setups.)
- Repos with **no GitHub remote**: init offers nothing automatic; it points at
  `me import ci` as the thing to wire into whatever CI exists. There is no
  local-hook fallback anymore — the truly-local case is a manual
  `me import git` (or a self-managed hook calling it).

### Example interactive flows (init's CI import step)

Common setup: repo `acme/checkout-api`, committed `.me/config.yaml` pinning
the space and `tree: /share/projects/checkout_api`. Earlier init steps
elided. Transcripts are illustrative, not exact copy.

**Case 1 — org-wide secret already provided** (org admin did §4's org-variant
setup once; the repo is on the org secret's visibility list). The org-level
service account (say `github-import`) holds a single **write grant at the
common parent of the org's project trees** — `write@/share/projects` — which
covers `/share/projects/checkout_api` and every other current or future repo
tree under it, so onboarding this repo requires no new grant at all. (Write,
level 2, is all it ever holds: enough to create/replace/prune memories and —
since levels are additive — to read, which the git importer's high-water
lookup needs; it is not an owner anywhere and holds nothing outside
`/share/projects`.) Orgs that instead chose per-project grants would need
`write@/share/projects/checkout_api` granted before the first workflow run —
that's the `import.service_account` verify/extend path noted below the
transcript:

```
── CI import ──────────────────────────────────────────────────────
✓ GitHub repository: acme/checkout-api
✓ Wrote .github/workflows/me-import.yml
✓ Found ME_API_KEY — organization secret, visible to this repo
  Using existing credentials; no service account or key created.
  (Can't verify a secret's contents — the first workflow run will,
   and it fails loudly if the key or grant is wrong.)
→ Commit .github/workflows/me-import.yml — imports start on the
  next push to the default branch (first run backfills history).
```

No prompts at all: the only question (provision or not?) is answered by the
secret's existence. If the org had committed `import.service_account:
github-import` in its `.me` template, one extra verify line would appear
(`✓ github-import holds write on /share/projects/checkout_api`).

**Case 2 — no secret, runner is a space admin** (solo/first-team-repo case):

```
── CI import ──────────────────────────────────────────────────────
✓ GitHub repository: acme/checkout-api
✓ Wrote .github/workflows/me-import.yml
• No ME_API_KEY secret found (checked repo and org secrets).
? Provision CI credentials now?
  If your org provides an org-level secret instead, choose No and
  ask an org admin to add this repo to its visibility list.
  ❯ Yes — create a repo-scoped service account
    No  — an org secret is expected
? Service account name: (checkout-api-import) ⏎
✓ Created service account checkout-api-import
  (bound admin group checkout-api-import-admins manages its keys)
✓ Granted write on /share/projects/checkout_api to checkout-api-import
? Set repo secret ME_API_KEY via gh (authenticated as @mat)?  ❯ Yes
✓ Minted api key "ci-import" → gh secret set ME_API_KEY
  (piped directly; the key was never displayed or stored)
→ Commit .github/workflows/me-import.yml — imports start on the
  next push to the default branch (first run backfills history).
```

**Case 3 — no secret, runner is NOT a space admin** (the expected common
case on team repos): identical until the SA creation, which is denied — the
enriched error (§4 "Authority failures name the admins") turns the step into
a hand-off instead of a dead end:

```
── CI import ──────────────────────────────────────────────────────
✓ GitHub repository: acme/checkout-api
✓ Wrote .github/workflows/me-import.yml
• No ME_API_KEY secret found (checked repo and org secrets).
? Provision CI credentials now? … ❯ Yes
? Service account name: (checkout-api-import) ⏎
✗ Creating a service account requires a space admin.
  Space admins for acme-eng:
    Alice Chen <alice@acme.dev>
    Bob Ito    <bob@acme.dev>
  Ask one of them to run:
    me service create checkout-api-import --admin mat@acme.dev
    me access grant write /share/projects/checkout_api checkout-api-import
  (--admin mat@acme.dev puts you in the service account's bound admin
   group — key management is then yours, no further admin needed.)
  Then re-run:
    me project ci
  It will find the service account, mint the key, and set the repo
  secret itself.
```

The step ends "pending" rather than failing the whole init run. The division
of labor matches the division of authority: the admin performs exactly the
two operations that require admin/owner authority (SA creation with the
asker seeded into the bound admin group, and the tree grant); the asker's
retry re-enters the provisioning path, where "ensure SA" and "ensure grant"
are now no-ops and key mint is authorized by their bound-admin-group
membership. The key is minted in the asker's own session and goes straight
into `gh secret set` — it never transits chat or email — and future rotation
is self-serve (`me project ci --rotate-key`).

## 8. What TNT-208's complaint becomes

With imports driven by push-to-main:

- Only main-ancestry commits are imported; `$prev` chains follow main's
  first-parent line, which is the history a teammate actually shares.
- Rebase churn on branches never touches the tree.
- Force-pushes to main fall back to a full walk (existing `isAncestor` check)
  — safe via replace idempotency. Note: hook-era high-water rows can point at
  commits not on main; the same existing fallback covers that on the first CI
  run.

## 9. Testing

- **Unit**: scaffolder output (YAML content — repo-agnostic, runtime
  default-branch gate — and managed-update semantics); init step gating
  (GitHub remote detection, hook migration offer); `.me` `import:` schema
  (strict-key errors stay fatal).
- **Integration/e2e** (local Postgres, existing e2e harness): fixture repo →
  `me import ci` with an api-key bearer → git + docs land under the pinned
  tree; second run is all-skip; doc delete + rerun prunes; zero-markdown repo
  skips docs phase; dry-run writes nothing.
- **Authority-failure UX**: a non-admin member attempting SA
  creation/key-mint/grant gets the enriched FORBIDDEN error carrying the
  effective space admins' `{name, email}` (§4) — integration test at the RPC
  layer, plus a CLI rendering test.
- **Failsafe pin**: `me import ci` under `CI=true`/GitHub-Actions-like env with
  `ME_API_KEY` runs without harness-failsafe interference.
- **Dogfood**: this repo adopts the workflow first (internal-launch milestone —
  memory-engine importing its own history and `docs/`).

## 10. Follow-ups (explicitly out of scope)

- **Hook-era pollution cleanup**: shared trees already contain unmerged/rebased
  shas. A `git_history` prune analog (keep-list = main's shas) hits the same
  keep-list byte budget as docs prune on big repos; needs its own design.
  File a ticket; don't block launch.
- **Published action** (`memory-build/me-import-action@v1`): once public, the
  scaffolded YAML can shrink to a single `uses:`. Launching with a
  self-contained workflow avoids private-repo action-sharing settings entirely
  and keeps the shim dependency-free.
- **Version-pinned installs** in CI (installer flag + guidance) once the CLI
  stabilizes.
- **Other CI systems**: GitLab/Jenkins templates around the same
  `me import ci`.
- Stale module header in `packages/cli/importers/git.ts` (describes a retired
  deterministic-id/`DO NOTHING` scheme) — fixed by commit 1 of the plan.

## 11. Alternatives considered

- **Fix the hook instead (fire on post-merge into main only)**: still
  per-clone, per-person credentials, silent failure; doesn't cover teammates or
  squash-merges done in the GitHub UI, which never touch any local clone.
  Rejected — the GitHub merge is the event, so GitHub is where the trigger
  lives.
- **Keep `me import git-hook` as a documented opt-in** (an earlier draft of
  this design): rejected. Its only defensible use (local-commit capture into a
  private tree) still produces rebase orphans and silent rot, and a shipped,
  documented command reads as endorsement. The primitive (`me import git`)
  covers anyone who wants to wire their own hook.
- **Flags in the workflow YAML instead of `.me` `import:` config**: more
  GitHub-native, but splits project truth across two files, makes local
  preview diverge from CI, and turns every behavior tweak into a YAML edit per
  repo. Rejected in favor of config-first (consistent with the harness
  design).
- **Reusable workflow / composite action now**: cleanest caller UX but
  requires org settings for private-repo action sharing and adds a cross-repo
  moving part before launch. Deferred (§10).
- **Webhook into the server (no CI at all)**: server pulls the repo on a
  GitHub webhook. Heavy new server surface (repo credentials, clone infra),
  and loses "any CI can run the CLI". Rejected for now.
- **Pinning `me` version in the workflow**: reproducible but freezes importer
  behavior per-repo; during the launch period we want fixes to propagate.
  Revisit post-launch.

## 12. Implementation plan (one PR, sequenced commits)

A single PR, built as independent, individually-reviewable commits in
dependency order (each leaves the tree green):

1. **`fix(cli): correct stale importers/git.ts module header`** — the header
   describes a retired deterministic-id / `DO NOTHING` scheme; align it with
   the real `(tree, name)` + `onConflict: "replace"` behavior. Trivial,
   standalone.
2. **`feat(cli): me import ci orchestrator`** — the command, the `.me`
   `import:` schema block, docs-phase skip-on-empty, per-phase summary
   output, e2e coverage running as a service-account key.
3. **`feat(server): authority denials name the space admins`** — enrich
   FORBIDDEN errors from admin-gated space-management ops with the effective
   admins' `{name, email}` (§4 "Authority failures name the admins"):
   SQL effective-admins lookup, server enrichment, protocol error-data type,
   CLI rendering in `me service` / `me apikey --service` / `me access grant`.
   Independent of this feature and useful on its own.
4. **`feat(cli): me project ci setup command + init step`** — the standalone
   setup command (managed-update YAML scaffolder, the §4 service-account
   walkthrough, `gh secret set` assist, TTY prompts +
   `--create-service-account`/`--service-account`/`--key-name`/
   `--rotate-key`) and the thin `ci-workflow` init step wrapping it.
5. **`feat(cli)!: remove me import git-hook`** — removed-command stub,
   `import-git-hook.ts` reduced to the marker-based cleanup helper, init's
   migration offer to strip installed hook blocks, init's `git-hook` +
   local-backfill steps dropped, docs section deleted.
6. **`docs: CI import`** — `docs/cli/me-project.md`, `docs/cli/me-import.md`,
   `docs/project-config.md`.
7. **`ci: adopt the me-import workflow in this repo`** — the dogfood
   `.github/workflows/me-import.yml` (service account + secret set up
   out-of-band by an operator).

Ticket mapping: commits 2, 4, 5 close **TNT-208** (hook removed, replaced by
the workflow); commits 2, 4, 7 deliver **TNT-209** (docs in the same
workflow); commit 3 is supporting UX either ticket would want. The former
"#147 service accounts" dependency is already discharged — #147 is merged.
