# Design sketch: optional email/password auth (no automated email)

**Status:** design direction agreed on the core decisions; two sub-calls remain
(see "Open decisions"). Not yet an implementation.
**Scope:** add an *optional*, self-host-oriented email + password login method
alongside the existing GitHub/Google OAuth, **without sending any email**.

**Decisions locked in so far:**

- **D1 — `email_verified` semantics:** keep its current meaning ("an identity
  provider vouched for this address"); do **not** corrupt it. Go with **Option A**
  (credential accounts stay `email_verified = false`; only the *login* gate learns
  to trust a credential session).
- **D4 — hosted policy:** memory.build stays **OAuth-only**. The feature is
  self-host-only, achieved purely by leaving the flag off in the hosted deploy
  config — no enforcement code.
- **D2 / D3 direction:** closed (admin-created) registration *and* password reset
  both require a **server-operator surface**, not an in-app RPC — because the
  product has no global/server admin and space-admin is the wrong authority for
  account-level actions (see "The authority problem" below). Whether that surface
  lands in v1 or as an immediate fast-follow is still open.

## Goals & non-goals

**Goals**

- Let a self-hoster enable username(email) + password login with a single
  config flag, with **zero email infrastructure required**.
- Keep the CLI working unchanged.
- Keep the hosted deployment (memory.build) exactly as it is today (flag off).
- Leave a clean seam so a future "optional SMTP" upgrade (real verification +
  self-service reset) is additive, not a rewrite.

**Non-goals (this pass)**

- Sending verification or password-reset email.
- Magic-link email login.
- Changing the OAuth flows.

## Guiding principle: reuse the "admin delivers the secret" model

The product already has **no automated email anywhere**. Invitations (both
email-constrained and open "magic links") mint a token that the **admin shares
out-of-band** — the server never emails anyone (`me space invite` prints
`Share this link: <url>`; the token is re-readable via `invite.list`). A
no-email email/password design is therefore *consistent* with the existing
model, not a workaround. Password reset follows the same pattern — a
server-minted token handed over out-of-band — though minted by the **deployment
operator**, not a space admin (see "The authority problem" for why account-level
actions can't be space-admin-gated).

---

## What exists today (the two blockers)

Human login funnels through better-auth → a web session. The CLI's `me login`
is OAuth 2.1 auth-code + PKCE + loopback, but the actual *authentication* happens
**in the browser** on the `/login` page (`LoginPage` → `SignInCard`). So adding a
password method to that page makes the CLI work with **no CLI changes**.

Two concrete things block email/password today:

1. **DB CHECK constraint.** `auth.accounts.provider_id` is constrained to
   `in ('google','github')` (`incremental/002_accounts.sql:11`). Better-auth's
   email/password writes an account row with `provider_id = 'credential'` and the
   hashed password in the existing (currently unused) `accounts.password` column.
   The constraint must be relaxed to allow `'credential'`.

2. **The verified-email login gate.** `betterauth.ts` has a
   `session.create.before` hook that throws `EMAIL_NOT_VERIFIED` unless
   `users.email_verified` is true (`betterauth.ts:130`). Social providers assert a
   verified email; a password sign-up defaults to `email_verified = false`, so
   **without handling, every password login is rejected**. Invitation discovery
   (`invite.pending`/`accept`) is also gated on `emailVerified`.

The design below addresses both.

---

## Configuration

A single feature flag, env-var driven (matches the existing
`GITHUB_CLIENT_ID`/… style read in `packages/server/start.ts`):

| Env var | Default | Meaning |
|---|---|---|
| `AUTH_EMAIL_PASSWORD` | `false` | Master switch for email/password login. |
| `AUTH_EMAIL_PASSWORD_SIGNUP` | `true` when enabled | Allow open self-service sign-up. `false` = closed registration; accounts are created only via the server-operator surface (see below). |
| `AUTH_EMAIL_PASSWORD_MIN_LENGTH` | `8` | Minimum password length (passthrough to better-auth). |

Notes:

- Flag **off** ⇒ the server behaves exactly as today. No new UI, no new routes,
  `provider_id='credential'` never occurs. **This is exactly how hosted
  (memory.build) stays OAuth-only (D4): the hosted deploy config simply never
  sets `AUTH_EMAIL_PASSWORD=true`.** No enforcement code — config discipline,
  consistent with how the OAuth provider vars already work.
- `AUTH_EMAIL_PASSWORD_SIGNUP` (the `disableSignUp` toggle) is an option *under*
  better-auth's `emailAndPassword` block, which only exists when the master flag
  is on. So it is inherently self-host-only and **inert on hosted** — no
  interaction with the OAuth-only hosted deployment.
- The existing startup warning ("No OAuth providers configured") is relaxed:
  having *either* a social provider *or* email/password enabled satisfies it;
  the warning fires only when **no** login method is configured.
- Both social and email/password may be enabled at once — better-auth is happy
  to expose both.

---

## Server changes

### 1. better-auth config (`packages/server/auth/betterauth.ts`)

Add the (built-in, no plugin) `emailAndPassword` block, gated on the flag, and
plumb the option through `BetterAuthOptions` + `createBetterAuth` in
`start.ts`.

```ts
emailAndPassword: opts.emailPassword?.enabled
  ? {
      enabled: true,
      minPasswordLength: opts.emailPassword.minPasswordLength ?? 8,
      // Open registration toggle. When false, sign-up is refused; accounts are
      // provisioned only via the server-operator surface (see "The authority
      // problem"). Self-host-only; inert on hosted (block absent when flag off).
      disableSignUp: !opts.emailPassword.allowSignUp,
      // No email sender is configured, so verification cannot be required.
      // Credential accounts stay email_verified=false (Option A); the login gate
      // trusts them instead of the row's flag.
      requireEmailVerification: false,
      // We do NOT wire sendResetPassword — there is no email sender. Reset is an
      // operator-minted out-of-band link instead (see "Password reset" below).
      autoSignIn: true,
    }
  : undefined,
```

### 2. The `email_verified` question (the crux) — DECIDED: Option A

**Decision:** keep `email_verified` meaning exactly what it means today — "an
identity provider (GitHub/Google) vouched that this person controls this
address." We do **not** corrupt it for credential accounts.

In the no-email design a credential address is **unproven** (no one clicked a
link), so the honest stored value is `false`. But `false` trips the
`session.create.before` login gate (`betterauth.ts:130`). So the gate — and only
the gate — learns to treat a credential-backed session as allowed:

Expressed as a small helper the hook calls, e.g. `isLoginAllowed(user, accountProviderId)`:

```
allow if provider is credential                    // no-email: trust it at login
allow if user.email_verified                       // social, verified
else block EMAIL_NOT_VERIFIED                       // social, unverified
```

Since GitHub/Google only release verified emails, the social branch is
effectively unchanged; credential logins are admitted **without** flipping
`email_verified`. This keeps the flag semantically clean and makes a future SMTP
upgrade a pure addition (require a verification click → set `email_verified =
true` for credential accounts too — no data migration, no second column).

**Rejected — Option B (`email_verified = true` on sign-up):** trivial (no gate
change), but it makes `email_verified` mean two different things and, worse, lets
a self-registered unproven address satisfy email-keyed authorization (invitation
discovery — see below). Explicitly not chosen.

Implementation note: the hook receives the session; telling a credential session
from a social one needs a small `accounts` lookup for `provider_id='credential'`
(login is infrequent, so the cost is negligible). To verify against the exact
better-auth `databaseHooks.session.create.before` signature at build time.

### 3. Invitation implications

Invitation **discovery** (`invite.pending` / `invite.accept`) is gated on
`emailVerified` (`packages/server/rpc/user/invitation.ts:40`). Under Option A,
credential accounts have `emailVerified = false`, so:

- They **cannot** use the "log in and see my pending invites" discovery path.
- They **can** join via a shared **open link** (`invite.redeem`, email ignored) —
  which is exactly the "admin hands a link to a specific person out-of-band"
  model. This is the intended onboarding path for credential users.
- They **cannot** redeem an *email-constrained* link (redeem passes
  `emailVerified ? email : null`, so the SQL email check fails).

This is a **deliberate, safe consequence** of Option A, not a bug: since a
credential email is unproven, honoring an email-addressed invitation for it would
let anyone who self-registers `alice@corp.com` claim invitations meant for the
real Alice. Open links avoid that because the token itself is the secret the
admin delivered to the right person.

**Remaining sub-decision (open):** whether to let credential users redeem an
*email-constrained* **link** (the token path, not discovery). That path already
requires the token — a real secret shared with the intended person — so trusting
an unverified credential email *there* is low-risk. Options: (a) **open-links
only** for credential users (simplest, recommended for v1), or (b) also honor
the credential user's own (unverified) email for email-constrained *redeem* while
keeping *discovery* verified-only. Note the danger lives only in **discovery**
(no token), which stays verified-only either way.

### 4. Closed registration & account provisioning — see "The authority problem"

When `AUTH_EMAIL_PASSWORD_SIGNUP=false`, accounts can't be self-created, so they
must be provisioned some other way. Critically, **this is not an in-app
space-admin action** — see the dedicated section below for why, and for the
server-operator surface that owns both account creation and password reset.

---

## The authority problem (drives D2 + D3)

Both "admin-created accounts" (D2, closed registration) and "password reset" (D3)
need an authority to perform them. **The product has no such authority today**,
and this reshapes both decisions.

**There is no global / server / instance admin.** Verified across the codebase:
no `superuser` / `global-admin` / `is_superuser` concept exists. Every "admin" is
**space-scoped** — `principal_space.admin`, structural authority over *one
space's* roster. First-login provisioning (`provision.ts`) makes no user special;
`core.createUser` is an internal store call, not an authorized RPC.

**Space-admin is the *wrong* authority for these actions** — using it would be a
privilege-escalation hole:

- Account creation and password reset are **account-level, cross-space**
  operations.
- A space admin who could reset a shared member's password would take over that
  user's **entire account** — including all of that user's *other* spaces (api
  keys / PATs are global per-principal, working in any space the principal
  belongs to). A space admin must never be able to do that.

**Conclusion: these are server-operator actions.** The authority is "whoever
controls the deployment" — the same person who holds `BETTER_AUTH_SECRET`, runs
migrations, and can `docker compose exec`. Not an RPC gated by an app role.

Two consequences for the implementation:

1. **It must run inside the server process.** Account creation / reset-token
   minting call `betterAuth.api.*` (e.g. `signUpEmail`, password/reset APIs),
   which live on the server's better-auth instance + auth pool. The `me` CLI is a
   separate *client* process and cannot call them directly — so this is a
   **server-side** subcommand or route, not a `me` CLI command.
2. **No global-admin role is invented.** We deliberately avoid adding a new authz
   axis or the better-auth `admin` plugin (see rejected options below).

### Operator surface — shape options

- **Server-side subcommand (recommended).** A command shipped with the server
  image, run by the operator in the container, e.g.
  `docker compose exec server me-admin create-user <email>` and
  `… reset-link <email>`. Calls `betterAuth.api.*` in-process. No network authz —
  authority is shell/exec access to the deployment. Fits the Docker Compose
  self-host story in `SELF_HOST.md`. **Zero hosted footprint.**
- **Localhost/secret-gated admin HTTP route.** An alternative if a subcommand is
  awkward; more surface area (a route + a shared operator secret) and easier to
  misconfigure. Not preferred.

### Rejected: the better-auth `admin` plugin

better-auth ships an `admin` plugin (`role='admin'` on users, plus
`createUser` / `listUsers` / `setPassword` / `ban` endpoints). Rejected because
it adds `role`/`banned` columns to `auth.users` and an admin surface that would
exist for **all** deployments **including hosted** (shared auth schema + shared
better-auth config), plus a "who is the first admin?" bootstrapping problem. That
violates D4's "self-host-only, no hosted footprint." A new global-admin concept
in `core` is even heavier and is likewise rejected.

---

## Database changes

One incremental migration (e.g. `auth/migrate/incremental/007_credential.sql`),
plus a bump of `AUTH_SCHEMA_VERSION`.

```sql
-- 007_credential: allow better-auth email/password (provider_id='credential').
-- The password hash lands in the existing accounts.password column (previously
-- always null under OAuth-only login).
alter table {{schema}}.accounts drop constraint accounts_provider_id_check;
alter table {{schema}}.accounts add constraint accounts_provider_id_check
  check (provider_id in ('google', 'github', 'credential'));
```

Notes:

- `accounts.password` already exists (`incremental/002_accounts.sql:19`) — no new
  column needed.
- The legacy `upsert_account` / `get_account_by_provider` SQL helpers
  (`idempotent/003_account.sql`) are not used by better-auth's Kysely adapter, so
  they need no change; the constraint lives on the table.
- The migration-drift test (`auth/migrate/migrate.integration.test.ts`) will need
  its expected-shape snapshot updated for the relaxed constraint.
- Migration footgun reminder (per AGENTS.md): this is a plain `alter table`, not a
  function signature change, so no `{{fn …}}` wrapper is needed.

---

## Web UI changes

### 1. Tell the UI the method is enabled

The server injects `window.__ME_BOOTSTRAP__` into `index.html`
(`packages/server/web/static.ts`). Extend the bootstrap object (currently just
`{ mode: "hosted" }` in `router.ts:132`) with the enabled auth methods:

```ts
bootstrap: {
  mode: "hosted",
  auth: {
    social: ["github", "google"].filter(configured),
    emailPassword: emailPasswordEnabled,
    emailPasswordSignup: emailPasswordSignupEnabled,
  },
}
```

`packages/web/src/api/bootstrap.ts` reads it into a typed `AUTH_METHODS`
constant. **CSP note:** the bootstrap is a single inline `<script>` allow-listed
by sha256 in `static.ts`; adding fields is fine (the hash is recomputed at
runtime from the injected string), no CSP change needed.

### 2. Password form in `SignInCard`

`SignInCard.tsx` is shared by both `LoginPage` (CLI browser flow) and `AuthGate`
(in-app), so adding the form here lights up **both** surfaces at once. Render:

- social buttons (only for configured providers),
- an email + password form (only when `emailPassword` is enabled),
- a "Create account" toggle (only when `emailPasswordSignup` is enabled).

Wire it to better-auth's browser client (`api/auth-client.ts`), which already
targets the same-origin auth base path:

```ts
// sign in
await authClient.signIn.email({ email, password, callbackURL });
// sign up (when allowed)
await authClient.signUp.email({ email, password, name, callbackURL });
```

The **critical** detail that makes the CLI free: on the `/login` page the
`callbackURL` is the OAuth authorize endpoint + its signed params (unchanged from
today). A password sign-in there sets the session cookie and lands back on
authorize, which — me-cli being a trusted PKCE client with consent skipped —
issues the code to the CLI loopback. Same as social, different first step.

### 3. Error surfacing

`SignInCard` already reads `?error/&error_description` for the social flow; reuse
it for password errors (bad credentials, sign-up disabled, weak password).

---

## CLI: no changes required

`me login` (`packages/cli/commands/login.ts`) is unchanged. Its browser opens the
`/login` page; whether the user clicks "Sign in with GitHub" or types an
email/password, the outcome is identical: a session cookie, then the authorize
endpoint issues the PKCE code to the loopback listener, which the CLI exchanges
for tokens. The CLI never learns *how* the human authenticated. `me logout`,
`whoami`, api-key issuance, etc. are all unaffected.

(Worth an explicit e2e/manual check, but no code changes are anticipated.)

---

## Password reset without email

Self-service *email* reset is impossible (no sender), and — per "The authority
problem" — reset **cannot be an in-app space-admin RPC** (cross-space account
takeover). So reset is an **operator-minted out-of-band link**, landing on the
same server-operator surface as closed-registration account creation:

- The operator runs the server-side surface (e.g.
  `docker compose exec server me-admin reset-link <email>`), which mints a
  one-time token and prints `<server>/reset/<token>`.
- The operator hands that link to the user out-of-band (Slack/DM/paste), exactly
  like an invite link.
- The user opens it and sets a new password on a reset page (reuse the invite
  token + page pattern in the web UI).

**Direction (from the discussion):** if we enable email/password, we should ship
reset too — a login method with no recovery path is a real UX cliff. So the
operator surface (which brings *both* reset-links *and* closed-mode account
creation) is the natural companion to the login feature. Whether it lands in the
same v1 or as the immediate fast-follow is the remaining scope call (see Open
decisions).

**Later, optional SMTP (additive).** If `SMTP_*` (or a transactional-API key) is
ever configured, wire better-auth's `sendResetPassword` to a real sender and
expose a normal "Forgot password?" link. Purely additive; doesn't change the
above.

---

## Security considerations

- **Password hashing** is better-auth's own (scrypt by default) into
  `accounts.password`; core api-key hashing (sha256) is unaffected — different
  subsystem.
- **Open sign-up exposure.** With `AUTH_EMAIL_PASSWORD_SIGNUP=true` on an
  internet-exposed instance, anyone reachable can create an account. Membership is
  still explicit (a new user has no spaces and no grants until invited/added), so
  the blast radius is a user row that can see nothing. Note the product *already*
  has open registration for OAuth (first-login provisioning), so this isn't a new
  posture — but doc guidance should steer public deployments to closed sign-up
  (operator-provisioned accounts) or OAuth-only. A truly closed self-host runs
  email/password-only (no OAuth) with `AUTH_EMAIL_PASSWORD_SIGNUP=false`.
- **Operator surface authority = deployment access.** Account creation and
  reset-link minting are authorized by shell/`exec` access to the server, not an
  app credential — the same trust boundary as holding `BETTER_AUTH_SECRET` or
  running migrations. It must never be reachable as an ordinary
  space-admin-gated RPC (cross-space account takeover).
- **Unverified addresses.** In the no-email design an email is a *label*, not a
  proven fact. Don't let `email_verified=false` credential accounts satisfy
  email-keyed authorization beyond what's intended (see the invite discussion).
- **No new CSRF surface.** better-auth owns `/api/v1/auth/*`; the Origin-based
  CSRF gate for cookie creds is unchanged.
- **Rate limiting.** Consider better-auth's built-in rate limiting for the
  sign-in/sign-up routes (brute-force protection) — a config toggle, worth
  enabling by default when email/password is on.

---

## Testing

- **Migration:** update the auth migration-drift integration test for the relaxed
  `provider_id` constraint; add a case that inserts a `'credential'` account.
- **Server unit:** the `isLoginAllowed` gate helper — social verified/unverified,
  credential.
- **Server integration:** email/password sign-up + sign-in produce a valid
  session; sign-up refused when `disableSignUp`; whoami/provisioning stand up the
  core principal for a credential user (same lazy path as social).
- **Web:** `SignInCard` renders the right controls per bootstrap flags; the
  `/reset/<token>` page sets a new password against a valid token and rejects an
  invalid/expired/used one.
- **Operator surface:** `create-user` provisions a credential account (and its
  lazy core principal on first login); `reset-link` mints a single-use token that
  updates the password and can't be replayed. Verify it's server-side only (no
  RPC route, not reachable by a space admin).
- **CLI:** e2e login still succeeds against a server with email/password on
  (guards the "CLI unchanged" claim). Likely a manual/harness check given the
  browser step.

---

## Open decisions

**Resolved:**

1. ~~**`email_verified` semantics**~~ — **DECIDED: Option A.** Keep the flag's
   meaning; the login gate trusts credential sessions; credential accounts stay
   `email_verified = false`. (§Server 2.)
2. ~~**Hosted policy**~~ — **DECIDED: OAuth-only.** Self-host-only via config
   (flag off in hosted deploy); no enforcement code. (D4.)
3. ~~**Registration & reset authority**~~ — **DECIDED: server-operator surface,**
   not an in-app RPC (no global admin exists; space-admin would be cross-space
   escalation). No better-auth admin plugin, no new global-admin role. (§The
   authority problem.)

**Still open:**

A. **Scope of v1** — does the server-operator surface (closed-mode account
   creation + reset-links) ship *in v1*, or does v1 land open-sign-up-only with
   the operator surface as the immediate fast-follow? Leaning: since a login
   method needs a recovery path, pull at least **reset-links** into v1; closed
   mode can follow. Confirm.

B. **Email-constrained-link redeem for credential users** — open-links-only
   (simplest, recommended) vs also honoring the credential user's unverified
   email for the *token* redeem path (discovery stays verified-only regardless).
   (§Server 3.)

C. **Operator surface shape** — server-side subcommand run via
   `docker compose exec` (recommended) vs a localhost/secret-gated admin route.
   (§The authority problem → Operator surface.)

---

## Rollout summary

| Area | File(s) | Change |
|---|---|---|
| Config | `packages/server/start.ts` | read `AUTH_EMAIL_PASSWORD*`, pass to `createBetterAuth`; relax the "no providers" warning |
| better-auth | `packages/server/auth/betterauth.ts` | `emailAndPassword` block; `isLoginAllowed` gate helper |
| DB | `packages/database/auth/migrate/incremental/007_credential.sql`, `version.ts` | relax `provider_id` CHECK; bump schema version |
| DB test | `auth/migrate/migrate.integration.test.ts` | update drift snapshot; credential-account case |
| Web bootstrap | `packages/server/router.ts`, `packages/web/src/api/bootstrap.ts` | carry enabled auth methods to the client |
| Web UI | `packages/web/src/components/SignInCard.tsx`, `api/auth-client.ts` | password form + sign-up toggle; email sign-in/up calls |
| Web UI (reset) | new `/reset/<token>` page (reuse invite page pattern) | set-new-password page the operator-minted link points at |
| Operator surface | server-side subcommand (in `packages/server`), calling `betterAuth.api.*` | `create-user` (closed-mode provisioning) + `reset-link` minting; runs in-process via `docker compose exec` |
| CLI | — | none (browser-based OAuth loopback is method-agnostic; operator surface is server-side, not the `me` client) |
| Docs | `SELF_HOST.md`, `.env.sample`, `AGENTS.md` auth summary | document the flag, no-email caveats, and the operator commands |
</content>
</invoke>
