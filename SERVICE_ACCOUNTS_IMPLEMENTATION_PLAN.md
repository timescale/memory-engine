# Service Accounts Implementation Plan

> **Status**: Draft checklist. This tracks the base service-account feature so
> implementation can proceed without losing the design intent in
> `SERVICE_ACCOUNTS.md`.

## Scope

Implement base service accounts (`principal.kind = 's'`): space-scoped,
api-key-authenticated principals administered by user members of a bound admin
group.

Base scope includes:

- Creating/listing/renaming/deleting service accounts.
- Creating a bound admin group at service-account creation time.
- Admin-group members and space admins managing service-account api keys.
- Service accounts participating in tree access and ordinary groups.
- Service accounts optionally being granted `principal_space.admin`, while
  blocking service-account api keys from deleting spaces.

Base scope excludes:

- `can_invite` / `can_deprovision` provisioning capabilities. Tracked by
  [TNT-203](https://linear.app/tigerdata/issue/TNT-203/add-scoped-provisioning-capabilities-for-service-accounts).
- Any `X-Me-As-Service` mode. Service accounts authenticate with `ME_API_KEY` or
  `--api-key` only.

Related merged track:

- [TNT-200](https://linear.app/tigerdata/issue/TNT-200/fix-memory-rpc-auth-gate-space-membership-must-come-from-principal)
  fixed the memory RPC admission gate so `principal_space` membership, not
  non-empty `build_tree_access`, controls endpoint admission. Zero-tree-access
  and structural-only service-account behavior are now covered by tests.

## Locked Decisions

- Service accounts use `kind = 's'`.
- Service accounts are **space-scoped** (`principal.space_id` is non-null).
- Service accounts are credential-bearing members (`member_id = id` for `s`).
- Service accounts use api keys from the existing `core.api_key` table.
- Service accounts have no owner and no owner clamp.
- Service accounts have no home grant and are not added to the default group by
  default.
- Only space admins can create service accounts.
- Creating a service account creates a bound admin group.
- The service-account principal points to the admin group via `admin_id`, which
  references `principal(group_id)`.
- The bound admin group behaves like an ordinary group for membership and data
  grants; service-account administration authority is limited to its direct user
  members by `is_service_account_admin`.
- Deleting the service account deletes the bound admin group.
- Directly deleting the bound admin group is forbidden.
- The bound admin group cannot be a space-admin group.
- The bound admin group cannot be the default group.
- The service account is **not automatically added** to its bound admin group;
  adding it later is not specially prevented.
- Grants to the bound admin group work like any group grant: the service account
  receives them only if it is actually a member of that group.
- Service accounts may be members of ordinary groups.
- Service accounts may hold `group_member.admin` on ordinary groups.
- Service accounts may be explicitly made `principal_space.admin`, but this is
  discouraged.
- Service-account api keys cannot mint/revoke api keys.
- Service-account api keys cannot delete spaces, even if the service account is
  a space admin.
- Granting access to a service account uses normal grant authority: grantor must
  be a space admin or hold `owner@P` for path `P`.
- Revoking access from a service account is allowed for space admins and members
  of the service account's admin group.

## Phase 1: Core Schema Migration

Goal: make service accounts representable and enforce core invariants in the DB.

- [x] Update `core.principal.kind` check to include `'s'`.
- [x] Update generated `member_id` to include service accounts:
  `kind in ('u', 'a', 's')`.
- [x] Avoid generated `service_account_id`; not needed for Phase 1 constraints.
- [x] Update `space_id` invariant:
  - [x] `kind in ('g', 's')` requires `space_id is not null`.
  - [x] other kinds require `space_id is null`.
- [x] Add `admin_id uuid references principal(group_id)`.
- [x] Add check constraint:
  - [x] `kind = 's'` requires `admin_id is not null`.
  - [x] `kind != 's'` requires `admin_id is null`.
- [x] Add per-space service-account name uniqueness.
- [x] Verify existing per-space group name uniqueness still handles bound admin
  groups.
- [x] Add a DB comment for `admin_id` explaining it points to the
  bound admin group.

Migration cautions:

- [x] No function signatures changed; no `{{fn ...}}` wrapper needed.
- [x] Audit existing `kind in ('u','a')`, `kind != 'a'`, `kind = 'a'`, and
  `member_id` assumptions.

Likely files:

- `packages/database/core/migrate/incremental/002_principal.sql`
- `packages/database/core/migrate/idempotent/*.sql`
- migration integration tests

## Phase 2: Core SQL Functions And Constraints

Goal: create service accounts atomically and protect their bound admin groups.

- [x] Add helper function to identify bound admin groups. Prefer a helper that
  returns the owning service account id or null, e.g.
  `service_account_for_admin_group(_group_id uuid) returns uuid`.
- [x] Add `create_service_account` SQL function that atomically:
  - [x] creates the bound admin group (`kind='g'`, same `space_id`);
  - [x] creates the service-account principal (`kind='s'`, same `space_id`,
    `admin_id = group.id`);
  - [x] rosters the service account into `principal_space` with `admin=false` by
    default;
  - [x] rosters the bound admin group into `principal_space` through existing
    group creation behavior;
  - [x] adds optional initial user admins to the bound admin group;
  - [x] optionally marks those initial members as `group_member.admin` based on
    input.
- [x] Ensure service-account creation gives no tree grants.
- [x] Ensure service-account creation does not add the service account to the
  default group.
- [x] Add deletion behavior:
  - [x] deleting the service account deletes the bound admin group;
  - [x] group-member rows, tree grants, and roster rows cascade/clean up.
- [x] Add constraint trigger preventing direct deletion of a bound admin group.
- [x] Add constraint trigger preventing a bound admin group from being made a
  space-admin group.
- [x] Add constraint trigger preventing a bound admin group from becoming the
  default group.
- [x] Retire the earlier special non-user membership guard for bound admin
  groups; explicit membership now follows ordinary group semantics.
- [x] Allow service accounts to be ordinary group members.
- [x] Allow service accounts to hold `group_member.admin` on ordinary groups.
- [x] Keep agents barred from effective group-admin authority.

Likely SQL areas:

- principal functions
- membership functions
- group-member functions
- principal-space admin trigger functions
- default-group constraints

## Phase 3: Protocol Types And Contracts

Goal: expose service-account concepts in shared schemas before wiring handlers.

- [x] Add `kind: 's'` to shared principal-kind schemas/types.
- [x] Add service-account response types with at least:
  - [x] `id`
  - [x] `name`
  - [x] `adminId`
  - [x] `spaceId` or space slug as appropriate
  - [x] `createdAt`
  - [x] `updatedAt`
- [x] Add request/result schemas for service-account lifecycle methods:
  - [x] create
  - [x] list
  - [x] rename
  - [x] delete
- [x] Add request/result schemas for service-account admin group management if
  the existing `group.*` surface is not sufficient. Existing `group.*` contracts
  are sufficient because callers manage the bound group by `adminId`.
- [x] Add request/result schemas for service-account api-key management if
  existing api-key methods cannot be parameterized cleanly. Existing `apiKey.*`
  contracts are sufficient because they already take explicit `memberId`.
- [x] Decide whether `principal.list` includes service accounts by default or
  requires `kind='s'` filter support. It includes service accounts by default,
  and the optional kind filter now accepts `s`.

Likely packages:

- `packages/protocol`
- `packages/client`

## Phase 4: Effective Access

Goal: make service accounts work with existing data-plane authorization.

- [x] Add `kind='s'` branch in `build_tree_access`.
- [x] Service-account effective access should be user-like:
  - [x] direct `tree_access` grants;
  - [x] grants inherited from ordinary groups where the SA is a member.
- [x] No owner clamp.
- [x] No home-path special casing.
- [x] Confirm `~` behavior for service accounts is either rejected or undefined
  intentionally. Current behavior is intentionally undefined until the server
  auth context carries principal kind; service accounts have no home grant, so
  effective access does not include a home path.
- [x] Verify data-plane SQL functions require no changes because they consume
  `_tree_access` jsonb.

Likely files:

- `packages/database/core/migrate/idempotent/003_tree_access.sql`
- `packages/database/space/path.ts` or equivalent path helpers if `~` handling
  needs service-account-specific behavior

## Phase 5: Core Store API

Goal: expose the new SQL functions in TypeScript.

- [x] Add core-store methods for service-account lifecycle:
  - [x] create
  - [x] list
  - [x] get/lookup if needed
  - [x] rename
  - [x] delete
- [x] Add core-store method to check whether a user administers a service
  account through the bound admin group.
- [x] Add core-store method to check whether a group is a bound SA admin group,
  or expose the SQL helper from Phase 3.
- [x] Ensure api-key creation can target a service-account `member_id`.
- [x] Preserve existing user/agent api-key behavior.

Likely files:

- `packages/engine/core/db.ts`
- `packages/engine/core/types.ts`
- `packages/engine/core/api-key.ts`
- `packages/database/core/migrate/idempotent/005_principal.sql`
- `packages/database/core/migrate/idempotent/011_service_account.sql`

## Phase 6: Server RPC Authorization

Goal: wire service-account management and avoid key privilege escalation.

- [x] Add dedicated `serviceAccount.*` methods unless a generalized principal
  surface is clearly simpler.
- [x] `serviceAccount.create`:
  - [x] requires space admin;
  - [x] creates SA + bound admin group atomically;
  - [x] supports optional initial users and optional `group_member.admin` flags.
- [x] `serviceAccount.list`:
  - [x] space admins can list all;
  - [x] admin-group members can list service accounts they administer;
  - [x] decide whether ordinary members can see service accounts through
    `principal.lookup` only.
- [x] `serviceAccount.rename`:
  - [x] space admin or admin-group member.
- [x] `serviceAccount.delete`:
  - [x] space admin only; deletion is destructive, so admin-group members cannot
    delete service accounts.
- [x] Key management:
  - [x] space admins can create/revoke/list keys for the SA;
  - [x] admin-group members can create/revoke/list keys for the SA;
  - [x] service-account api keys cannot create/revoke/list api keys.
- [x] Tree grants to service accounts:
  - [x] grant requires existing normal authority: space admin or `owner@P`;
  - [x] admin-group members get no special grant bypass;
  - [x] revoke allowed for space admins and admin-group members.
- [x] Group management:
  - [x] bound admin group follows ordinary group membership semantics;
  - [x] ordinary groups accept service accounts;
  - [x] service accounts can exercise ordinary `group_member.admin` with no
    unrelated tree grants.
- [x] Space admin behavior:
  - [x] allow `principal.add(admin=true)` or equivalent for SAs if caller is a
    space admin;
  - [x] bar service-account api keys from `space.delete` even if the SA is a
    space admin.

Likely files:

- `packages/server/rpc/memory/*`
- `packages/server/rpc/user/*`
- `packages/server/middleware/authenticate-space.ts`

## Phase 7: CLI

Goal: provide an operator-friendly surface without exposing hidden sharp edges.

- [x] Add `me service` command group.
- [x] Add `me service create <name>`:
  - [x] optional initial admin users;
  - [x] optional group-admin flags for those initial users;
  - [x] prints created service account id and admin group name/id.
- [x] Add `me service list`.
- [x] Add `me service rename`.
- [x] Add `me service delete`.
- [x] Add api-key commands for service accounts, either:
  - [x] `me apikey create --service <idOrName>`; or
  - [ ] `me service apikey create <idOrName>`.
- [x] Support `ME_API_KEY` / `--api-key` for service-account authentication.
- [x] Do **not** add `--as-service` or `X-Me-As-Service` support.
- [x] Make docs and help text clear that service-account keys are durable
  operational credentials and should be handled like production secrets.

Likely files:

- `packages/cli/commands/*`
- `packages/cli/config/*` if api-key resolution needs updates
- CLI tests

## Phase 8: Tests

Goal: lock down invariants before relying on the feature.

Database/core tests:

- [x] `kind='s'` can be inserted only with `space_id` and `admin_id`.
- [x] Service accounts get `member_id` and can own api keys.
- [x] Service-account names are unique per space.
- [x] Creating an SA creates a bound admin group.
- [x] Bound admin group follows ordinary group membership/data-grant semantics.
- [x] Bound admin group cannot be deleted directly.
- [x] Bound admin group cannot be made a space-admin group.
- [x] Bound admin group cannot be the default group.
- [x] Deleting the SA deletes the bound admin group.
- [x] Service accounts can join ordinary groups.
- [x] Service accounts can be ordinary group admins.
- [x] `build_tree_access` for SAs includes direct grants and ordinary group
  grants.

Server/RPC tests:

- [x] Only space admins can create service accounts.
- [x] Admin-group members can manage SA keys.
- [x] SA api keys cannot manage keys.
- [x] Admin-group members can rename but not delete service accounts.
- [x] Non-admin users cannot administer arbitrary SAs.
- [x] Service-account key can read/write memory according to `tree_access`.
- [x] Service-account key can exercise ordinary group admin on groups where it
  has `group_member.admin`.
- [x] Service-account key cannot delete a space even when SA is space admin.
- [x] Last-admin protections still apply when SAs and SA admin groups are
  involved.

CLI tests:

- [x] `me service create/list/rename/delete`.
- [x] Service-account api-key creation and revocation.
- [x] `ME_API_KEY` / `--api-key` with a service-account key.
- [x] No accidental support for `--as-service`.

## Phase 9: Documentation

Goal: make the new model understandable to users and future maintainers.

- [x] Update `AGENTS.md` authoritative model summary.
- [x] Update `docs/concepts.md`.
- [x] Update `docs/access-control.md`.
- [x] Add CLI docs for `me service`.
- [x] Add MCP docs only if service-account operations become MCP-exposed. No MCP
  management tools were added; MCP credential docs now mention service-account
  keys.
- [x] Update API/client docs if applicable.
- [x] Mention TNT-203 as future provisioning work if docs discuss invitations or
  HR/SSO sync.

## Phase 10: Follow-Up / Deferred Work

- [ ] Implement [TNT-203](https://linear.app/tigerdata/issue/TNT-203/add-scoped-provisioning-capabilities-for-service-accounts):
  `can_invite` and `can_deprovision`.
- [ ] Decide direct-add behavior for already-existing users.
- [ ] Decide invite list/revoke scope for service accounts.
- [ ] Decide deprovisioning scope.
- [ ] Decide whether SA-initiated management actions need richer audit records.

## High-Risk Areas To Watch

- Function signature drift in migrations. Use `{{fn ...}}` wrappers when needed.
- Existing `kind in ('u','a')` assumptions, especially around `member_id`, group
  membership, and api keys.
- Bound admin group delete/promotion/default-group constraints.
- Distinguishing the bound admin group from ordinary groups.
- Preventing api-key minting by service-account api keys.
- Preventing `space.delete` by service-account api keys.
- Structural authority must not require unrelated tree grants.
- Cascades when deleting a service account or removing a principal from a space.
