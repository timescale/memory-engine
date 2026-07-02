# Requirements: "Act as agent" via `X-Me-As-Agent`

## Context
Memory Engine authenticates humans (better-auth session / OAuth token / user PAT) and agents (agent-issued api key, `ME_API_KEY`). Agents are a user's owned, global service principals (`principal.kind='a'`, `owner_id` → the user). Today, to run *as* an agent you must hold that agent's api key.

We want a human-authenticated caller (session or user PAT) to run **as one of their own agents** by sending a header, so coding-harness integrations — including thin wrappers that shell out to the `me` CLI — can operate under an agent's identity **and be constrained to that agent's limitations**, without provisioning/distributing a separate agent key.

## Current state on `main` (branch point)
This document was trued up against the code on `main`. Relevant facts:

- **The `X-Me-As-Agent` feature is entirely unbuilt.** No `AS_AGENT_HEADER`, `ME_AS_AGENT`, `--as-agent`, `resolveAsAgent`, `authenticatedAs`, or client `asAgent` exists yet. Start from a fresh branch off `main`; no prior attempt is applied.
- **The `.me/` project-config reader already shipped** (`packages/cli/project-config.ts`, commit `6322340` + follow-ups). It walks up from cwd (honoring `--config-dir` / `ME_CONFIG_DIR`), validates a strict schema, and is already wired into `resolveServer` / `resolveSpace` / `resolveCredentials`. **It already parses an `agent` field** (project-config.ts) — but that field is currently inert, and its doc-comment still references the *old* `--agent` / `ME_AGENT` naming from `PROJECT_CONFIG_DESIGN.md`. This PR wires it (see Decision C) and fixes the comment.
- **The default-group + invites rework is merged** (`c349d57`, `50a2930`, …). Not needed by this feature, but it means `AGENT_ALLOWED` and the user-RPC gate are current.
- `packages/protocol/headers.ts` exports only `CLIENT_VERSION_HEADER` and `SPACE_HEADER` today.

## Goal
Add an **ambient "act-as-agent" mode** selected by a flag/env/header. When active, every request the client makes is authorized as the named agent on **both** RPC endpoints, and the server rejects anything that agent may not do. We **authenticate** using the agent's owner's credentials, but **authorize** as the agent.

## Terminology / naming (final)
- Header: **`X-Me-As-Agent`** (value = agent id or name). Add constant `AS_AGENT_HEADER = "X-Me-As-Agent"` to `@memory.build/protocol/headers` (alongside `CLIENT_VERSION_HEADER` / `SPACE_HEADER`).
- Env: **`ME_AS_AGENT`** (value = agent id/name, or the `.me` sentinel).
- CLI global flag: **`--as-agent <idOrName>`** (**required value** — Decision C; a value-less optional-value option is *not* used, to avoid the Commander swallow hazard below).
- **The `.me` sentinel:** the literal value **`.me`** means "use the project's agent" — the CLI substitutes `.me/config.yaml`'s `agent` id. `.me` is a **DB-guaranteed-impossible agent name**: agent names are constrained to `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$` (`core/migrate/incremental/008_principal_name.sql`), and `.me` starts with `.`, so it can never collide with a real agent. It is resolved **entirely client-side** and never sent to the server.
- The `.me/config.yaml` **`agent`** field supplies the *value* only when the flag/env value is the `.me` sentinel; it never activates the mode on its own (Decision C).
- Do **not** reuse `--agent`: `apikey --agent <agent>` (key *target*) and the `resolveAgentId` helper are unrelated and must stay untouched.

### Why the flag takes a required value (Commander hazard)
`--as-agent` is a **global** option on the root program, interleaved with subcommands + positionals. An **optional-value** global option (`--as-agent [idOrName]`) is greedy: Commander consumes the following token as the value when it doesn't start with `-`, so `me --as-agent search "q"` binds `asAgent="search"` and the `search` subcommand is eaten (likewise `me search --as-agent "q"` eats the query). There are **zero** optional-value options in the CLI today — every option is boolean or required-value (`--server <url>`, `--config-dir <dir>`). A **required-value** option has no such ambiguity (`me --as-agent .me search "q"` binds `.me`, leaving `search` as the subcommand), so `--as-agent <idOrName>` follows the existing convention. Value-less-style activation is expressed by the explicit `.me` sentinel instead of a bare flag.

## Core model
- **Ambient, not per-operation.** The mode applies uniformly to all requests in the process. The client never acts as the user for some calls and the agent for others.
- **Activation is always explicit.** The mode is turned on only by the flag or env (`--as-agent <v>` / `ME_AS_AGENT=<v>`). A `.me/config.yaml` `agent` id present in the tree does **not** by itself put `me` in agent mode — otherwise a human typing `me search` inside the project would silently act as the agent. The `.me` `agent` is consulted *only* when the operator opted in and passed the `.me` sentinel (Decision C). "The human is the one without the marker" still holds.
- **Constrained by design.** In agent mode, operations the agent isn't allowed to perform **fail server-side** (memory RPC: `treeAccess`/admin clamp; user RPC: the `AGENT_ALLOWED` allow-list). This is intended — it's the whole point (harnesses inherit the agent's limits).
- **Parity guarantee (must hold):** a human + `X-Me-As-Agent: <agent>` must be able to do **exactly** what that agent's own `ME_API_KEY` can do — no more, no less — on both endpoints.
- **Precedence:** if the bearer is itself an **agent api key**, the header is **ignored** (the bearer already *is* an agent; nothing to switch). Only a **human** credential (session / OAuth / user PAT) honors the header.
- **Server-side resolution + ownership check:** resolve the header value against `core.listAgents(<human principal id>)`, matching **id first, then name case-insensitively** (Decision B — mirrors `util.ts:resolveAgentId`, which lower-cases both sides). A miss (unowned/unknown/not-an-agent) → **HTTP 403** with code **`INVALID_AGENT`**.
- **Representation:** the server represents "human acting as agent" by overwriting the resolved principal to the agent and recording the human separately for observability only (`authenticatedAs`), reusing existing agent semantics so parity is automatic (no parallel authz path).
- **No DB migration.**

## Behavior matrix (both endpoints)
| Credential | `X-Me-As-Agent` | Result |
|---|---|---|
| Human session/OAuth | absent | acts as the human (unchanged) |
| Human session/OAuth | owned agent (id/name) | acts as the agent (constrained) |
| User PAT | owned agent | acts as the agent (constrained) |
| Agent api key | any value | header ignored; acts as the agent (the key's principal) |
| Human | unowned/unknown/non-agent | 403 `INVALID_AGENT` |
| Human acting-as agent | agent lacks access/permission for the op | fails as that agent would (403 FORBIDDEN / access error) |

The **header** value is always an explicit id/name (the CLI resolves the `.me` sentinel to a concrete agent id before sending — see Decision C). The server never sees the `.me` sentinel.

## Server design

### Memory RPC — `packages/server/middleware/authenticate-space.ts`
After resolving the principal (step 4), add an "act-as" step **before** the `buildTreeAccess` gate (step 5) and the `isSpaceAdmin` check (step 6):
- Read `AS_AGENT_HEADER`. Apply only when the bearer is human (`ownerId === null`; an agent key sets a non-null `ownerId` via `validateApiKey` → skip).
- Resolve via `core.listAgents(principalId)` (id, then case-insensitive name); miss → `error("X-Me-As-Agent '…' is not an agent you own", 403, "INVALID_AGENT")` (use `error(...)`, not `forbidden()`, so the code is set — `error`/`forbidden` are already imported here).
- On match: set `authenticatedAs = principalId` (the human), then `ownerId = principalId` (the human owns the agent), then `principalId = agent.id`.
- Doing this before steps 5–6 makes `treeAccess`, `~`-home nesting (`home.<human>.<agent>`), and `admin` all reflect the agent. **`buildTreeAccess(agentId, spaceId)` applies the `agent_tree_access` clamp internally** (it resolves the agent's owner itself — this is why the agent-key path already gets clamped with no owner arg), so reusing it yields byte-identical access to the agent-key path. `ownerId=human` is needed only so `~` nests under the human's home the same way the agent key would.
- Add `authenticatedAs: string | null` to `SpaceAuthContext` (default `null` on the non-act-as paths).

### User RPC — `packages/server/middleware/authenticate-user.ts`
Mirror the same step after principal resolution:
- Apply only when `kind === 'u'` (human: session/OAuth/user PAT); skip when `kind === 'a'` (agent key trumps).
- Resolve via `core.listAgents(userId)` (id, then case-insensitive name); miss → 403 `INVALID_AGENT` (import `error` from `../util/response`; today this file imports only `forbidden` / `unauthorized`).
- On match overwrite the context to the agent: `kind='a'`, `userId=agent.id`, `email=null`, `name=agent.name`, `emailVerified=false`, `viaApiKey=true` (**Decision B:** force true for strict agent-key parity), and `authenticatedAs=<the human's userId>`.
- **Decision A (switch location):** do this in the middleware. The router's lazy first-login provisioning is gated on `kind === 'u' && email !== null` (router.ts:198), so a switched (`kind='a'`) request skips it — which is correct: a human can only resolve an owned agent if they were already provisioned (owning an agent required an earlier `kind:'u'` `agent.create`), so provisioning is only ever skipped when already done.
- The existing `AGENT_ALLOWED` allow-list (`{whoami, space.list}`, user/index.ts:30) + `requireUserCaller` then constrains the agent automatically — no gate changes.
- Add `authenticatedAs: string | null` to `UserAuthContext`.

### Threading
- Add `authenticatedAs: string | null` to `SpaceRpcContext` (`rpc/memory/types.ts`) and `UserRpcContext` (`rpc/user/types.ts`); populate both in `router.ts`. The memory handler's context object (router.ts:162–172) and the user handler's (router.ts:209–219) both need the new field; the user handler's destructure (router.ts:189–190) must also pull `authenticatedAs`.
- Optional: in `rpc/handler.ts` (the identity-attribute block at lines ~154–172, which already emits `user.id` / `api_key.id`), add an `authenticated_as` span attribute when `ctx.authenticatedAs` is set (observability only; never authz).

### Parity invariant (must verify in code + tests)
Authorization reads only: memory RPC → `principalId`, `ownerId`, `treeAccess`, `admin`; user RPC → `kind`, `userId`. All are identical between the agent-key path and the act-as path. `apiKeyId` and `authenticatedAs` are **observability-only** and must never gate behavior.

## Client design (`packages/client`)
- `memory.ts`: add option `asAgent?: string`; when set, seed `config.headers` with `{ [AS_AGENT_HEADER]: asAgent }` (merge with the existing `X-Me-Space` entry, exactly as `space` already does at memory.ts:201). Add `setAsAgent(v: string)` (empty string clears the header) mirroring the existing `setSpace`. `transport.ts` needs no change (it already merges `config.headers`).
- `user.ts`: same additions — **but note `createUserClient` does not populate `config.headers` at all today**, so initialize it (`options.asAgent ? { [AS_AGENT_HEADER]: options.asAgent } : undefined`) and have `setAsAgent` lazily create/merge the object.
- CLI wrapper (`packages/cli/client.ts`) already spreads options through — no change.

## CLI design (`packages/cli`)

**Threading approach (Decision A — carry on `ResolvedCredentials`, not a new `build*Client` param).**
`buildMemoryClient(creds)` / `buildUserClient(creds)` and `resolveCredentials(globalOpts.server)` are each called from ~40 sites. Rather than change those signatures, resolve act-as once and carry it on the creds:

- **Global flag via a `preAction` override.** `--as-agent <idOrName>` is a **required-value global** option on the root program (`index.ts`). Seed it in the root `preAction` hook into a module-level override — **mirroring the existing `setConfigDirOverride` pattern** (index.ts:60–66, project-config.ts:166–177). This makes the flag ambiently visible to `resolveAsAgent()` without threading `globalOpts` through every command (and through `me mcp`, whose `optsWithGlobals()` also picks it up). A required value avoids the Commander optional-value swallow hazard (see "Why the flag takes a required value").
- **`resolveAsAgent()` in `credentials.ts`** — precedence, highest first:
  1. the flag override (from `preAction`),
  2. `ME_AS_AGENT` env,
  3. otherwise `undefined` (mode **off**).
  Value semantics: the resolved value is a string (the flag/env always carry a value — there is no boolean form). If the value is the **`.me` sentinel** (the literal `.me`), resolve it to `getProjectConfig()?.agent` (Decision C); if activated with `.me` but there is no `.me` `agent`, throw a clear error (e.g. `--as-agent .me needs an 'agent:' in .me/config.yaml, but none is in scope`). Any **other** non-empty value is an explicit id/name, returned verbatim. When neither flag nor env is present (or the env value is empty), return `undefined` **even if `.me` has an `agent`** (activation is explicit).
- **`resolveCredentials`** calls `resolveAsAgent()` and stores the result as `asAgent?: string` on `ResolvedCredentials`.
- **`util.ts`** `buildMemoryClient` / `buildUserClient` pass `asAgent: creds.asAgent` to the client factory. Applies uniformly to all commands (management commands then correctly fail server-side in agent mode). No call-site changes.
- **`me mcp`** (`commands/mcp.ts` + `mcp/server.ts`): `resolveCredentials` already yields `creds.asAgent`; thread it into `McpServerOptions` and pass to `createMemoryClient`. Keep `blankFlag` handling for plugin-placeholder strings if an inline `--as-agent` is added to the mcp command. The MCP server builds only a memory client — nothing else to wire.
- **Hooks** (`commands/opencode.ts`, `commands/claude.ts`): both build a client directly via `createMemoryClient({...})` from a resolved config (opencode.ts:280; claude hook is env-only). Pass `asAgent: creds.asAgent` there. Because the hooks resolve `.me` from the *session project's* directory, `ME_AS_AGENT=.me` naturally sources the agent id from that project's `.me/config.yaml`.
- **`project-config.ts` comment fix:** update the `agent`-field doc-comment (it currently says "Parsed for forward-compatibility but NOT yet wired … `--agent` / `ME_AGENT` is a follow-up") to reference the final `--as-agent` / `ME_AS_AGENT` / `X-Me-As-Agent` naming and note it is now wired as the value source for the `.me` sentinel.
- **Clean failure UX:** ensure the server `FORBIDDEN` in agent mode surfaces an understandable CLI message (e.g. "acting as agent '<name>'; this operation requires your user account — unset ME_AS_AGENT"). Do not pre-empt the server client-side.
- **Untouched:** `apikey --agent <agent>` and `opts.agent` in apikey; `resolveAgentId`; `agent.ts` commands.

## Out of scope (owned separately — do not implement here)
- `me space use` **writes** into `.me/config.yaml` (the config-mutating side of `PROJECT_CONFIG_DESIGN.md`). Reading `.me` is already shipped and is used here.
- Onboarding wizard, "agent grants without owner" tweak, attribution (`created_by`).
- Harness env injection of `ME_AS_AGENT=.me` (or the explicit agent id) into the agent's tool shells (OpenCode `shell.env`, Claude `settings.json` env, Codex `shell_environment_policy`, Gemini `.gemini/.env`). That integration wiring lives in `PROJECT_CONFIG_DESIGN.md`; this PR only makes `ME_AS_AGENT` / `--as-agent` mean something end-to-end.

## Tests
- **Space middleware integration** (`authenticate-space.integration.test.ts`): extends the existing fixtures (`seedUserSpace`, `addSpaceCreator`, the OAuth-token minting helper). Cases: human session + owned agent by **id** and by **name (mixed case)** → principal switch, `ownerId`=human, clamped `treeAccess`, `admin=false`, `authenticatedAs`=human; agent-key bearer + header → **ignored** (incl. a case where the header names a *valid* other owned agent, proving the key trumps); unowned/unknown/non-agent → 403 `INVALID_AGENT`; owned agent with no space access → 403.
- **User middleware integration** (`authenticate-user.integration.test.ts`): human + `X-Me-As-Agent` (id and mixed-case name) → `kind='a'`, `userId`=agent, `email=null`, `viaApiKey=true`, `authenticatedAs`=human; agent-key bearer + header → ignored; unowned/unknown → 403 `INVALID_AGENT`.
- **Parity tests (both endpoints):** context from human+`X-Me-As-Agent` equals the agent-key context on the authz fields (space: `principalId`/`ownerId`/`treeAccess`/`admin`; user: `kind`/`userId`); `apiKeyId`/`authenticatedAs` may differ.
- **Client unit** (`memory.test.ts`, `user.test.ts`): sends `X-Me-As-Agent` when `asAgent` set; omits otherwise; `setAsAgent` sets/clears (verify `user.ts` initializes `config.headers` when it was previously unset).
- **`resolveAsAgent` unit** (`credentials.test.ts`): flag override > env; explicit id/name passes through verbatim; the `.me` sentinel **with** a `.me` `agent` → resolves to that id; the `.me` sentinel **without** a `.me` `agent` → throws; neither flag nor env (even with a `.me` `agent`) → `undefined` (mode stays off); an agent literally passed as `.me` is impossible server-side, so the sentinel never shadows a real agent.
- **e2e** (`e2e/cli.e2e.test.ts`): with `ME_AS_AGENT=<id>` set — `me whoami` reports the agent (`kind:"a"`, null email); `me space list` shows the agent's spaces; a memory op is constrained to the agent's access; and a **management op fails** (`me apikey create` / `me agent list` exit non-zero, FORBIDDEN). Also assert `me apikey create --agent <id>` still works when **not** in agent mode (no flag collision), and that `me --as-agent <id> search "q"` does not eat the `search` subcommand (required-value flag).

## Verification
- After code changes: `./bun run typecheck` and `./bun run check` (fast, no DB).
- Before finishing: `./bun run check:full` against the local `me-postgres` container (`docker start me-postgres || ./bun run pg:docker`). e2e runs under `TEST_CI=1`; any new `describe.skipIf` must include `!process.env.TEST_CI`.
- Update `AGENTS.md`: state that `X-Me-As-Agent` is honored on **both** endpoints, that agent mode is ambient (`ME_AS_AGENT` / `--as-agent <idOrName>`, with the `.me` sentinel sourcing the id from `.me/config.yaml`'s `agent`) and agent-constrained, that an agent api key trumps the header, and that management ops fail in agent mode.

## Key implementation gotchas (from investigation of `main`)
- `error(msg, 403, "INVALID_AGENT")` — `forbidden()` takes no code. `authenticate-space.ts` already imports `error`; `authenticate-user.ts` imports only `forbidden`/`unauthorized` → add the `error` import.
- `core.listAgents(ownerId)` → `Principal[]` (`{id, kind, name, ownerId, createdAt, updatedAt}`, engine/core/types.ts:43); match id then case-insensitive name (avoid UUID parsing / `getPrincipal` type errors).
- Space: `ownerId !== null` ⇔ bearer is an agent key. User: `kind === 'a'` ⇔ agent key. These are the "skip the header" discriminators and the parity precedence.
- `validateApiKey` returns `owner_id` = the key principal's owner (non-null for an agent, null for a user PAT) — this is what makes the precedence work (authenticate-space.ts:150).
- `buildTreeAccess(memberId, spaceId)` takes only those two args and resolves the agent clamp internally — do **not** try to pass the owner; that is what guarantees parity for free.
- Router user handler provisioning is `kind==='u' && email!==null`-gated (router.ts:198) — middleware switch avoids misfiring it.
- MCP server builds only a memory client (mcp/server.ts:1209).
- The `.me` reader (`getProjectConfig()`) is memoized and honors `--config-dir`/`ME_CONFIG_DIR`; it is already imported by `credentials.ts`.
- Postgres.js/test gotchas per `AGENTS.md` (jsonb via `sql.json`, `expectReject` for query failures, `--timeout 30000` for single integration files).

## Decisions (resolved with reviewer)
- **A — CLI threading:** carry `asAgent` on `ResolvedCredentials` (resolved once via a `preAction`-seeded override + env, mirroring `setConfigDirOverride`), not a new `build*Client(creds, globalOpts)` parameter. Minimal call-site churn; ambient env works everywhere.
- **B — name match casing:** case-insensitive (matches `resolveAgentId`). Also: force `viaApiKey=true` on the user-RPC switch for strict agent-key parity.
- **C — value-less activation via the `.me` sentinel:** the flag is **required-value** `--as-agent <idOrName>` (not an optional-value `[idOrName]`), and the literal value **`.me`** resolves to `.me/config.yaml`'s `agent` id (the `.me` reader + field already exist on `main`). `.me` is collision-proof: agent names are constrained to `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$` (`008_principal_name.sql`), so a name can never start with `.`. This choice (a) avoids the Commander optional-value swallow hazard (a required value never eats the subcommand) and (b) removes the earlier `1`/`true` magic-value ambiguity. Activation stays explicit — a `.me` `agent` alone never enables agent mode. Replaces the earlier "bare → NotImplemented" rule.

## Open items to confirm with the reviewer before merge
- Whether `me mcp` should also accept an **inline** `--as-agent` (in addition to the global one). With the global-flag + `preAction` override, `me mcp --as-agent x` and `ME_AS_AGENT` already both work; an inline option is only ergonomic sugar.
- Branch name for the fresh start (e.g. `jgpruitt/as-agent`).
