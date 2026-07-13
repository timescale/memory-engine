# Design sketch: optional email/password auth (no automated email)

**Status:** exploratory sketch for discussion — not a committed plan.
**Scope:** add an *optional*, self-host-oriented email + password login method
alongside the existing GitHub/Google OAuth, **without sending any email**.

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
model, not a workaround. Password reset, if built, follows the same pattern: a
server-minted token an admin hands over out-of-band.

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
| `AUTH_EMAIL_PASSWORD_SIGNUP` | `true` when enabled | Allow open self-service sign-up. `false` = existing accounts only (created via CLI/admin). |
| `AUTH_EMAIL_PASSWORD_MIN_LENGTH` | `8` | Minimum password length (passthrough to better-auth). |

Notes:

- Flag **off** ⇒ the server behaves exactly as today. No new UI, no new routes,
  `provider_id='credential'` never occurs.
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
      // Open registration toggle. When false, sign-up is refused (accounts are
      // provisioned by an admin/CLI path instead).
      disableSignUp: !opts.emailPassword.allowSignUp,
      // No email sender is configured, so verification cannot be required.
      requireEmailVerification: false,
      // We do NOT wire sendResetPassword — self-service email reset is not a
      // feature in the no-email design (see "Password reset" below).
      autoSignIn: true,
    }
  : undefined,
```

### 2. The `email_verified` question (the crux)

Decide what `email_verified` means for a `provider_id='credential'` account. In
the no-email design the address is **unproven** (no one clicked a link), so the
honest value is `false`. But `false` trips the login gate. Two viable options:

**Option A — trust credential accounts at the gate (recommended for no-email).**
Leave `email_verified = false` in the row (it's the truth — unverified), and make
the `session.create.before` gate *pass* for credential-backed sessions. The gate
becomes: "block only if the login came from a social provider whose email is
unverified." Since GitHub/Google only release verified emails, the social branch
is effectively unchanged; credential logins are admitted.

- Pro: honest data (`email_verified` still reflects "provider verified"), and a
  later SMTP upgrade can flip real verification on without a data migration.
- Con: the gate logic must learn how to tell "this session is credential-backed."
  The hook receives the session; resolving the account's `provider_id` is an
  extra lookup. Cleaner alternative: gate on a per-user fact instead (below).

**Option B — set `email_verified = true` on credential sign-up.**
Simplest: the gate is untouched; credential users pass because their row says
verified.

- Pro: trivial; no gate changes; invitation discovery "just works."
- Con: `email_verified` now means two different things ("provider verified" for
  social, "exists" for credential). A future SMTP upgrade that wants *real*
  verification must distinguish them, likely needing a data migration or a
  second column.

**Recommendation:** Option A, expressed as a small helper the gate calls, e.g.
`isLoginAllowed(user, accountProviderId)`:

```
allow if provider is credential                    // no-email: trust it
allow if user.email_verified                       // social, verified
else block EMAIL_NOT_VERIFIED                       // social, unverified
```

This keeps `email_verified` semantically clean ("an identity provider vouched
for this address") and makes the future SMTP path a pure addition (require a
verification click → set `email_verified = true` for credential accounts too).

### 3. Invitation implications

Invitation **discovery** (`invite.pending` / `invite.accept`) is gated on
`emailVerified` (`packages/server/rpc/user/invitation.ts:40`). With Option A,
credential accounts have `emailVerified = false`, so:

- They **cannot** use the "log in and see my pending invites" discovery path.
- They **can** join via a shared **open link** (`invite.redeem`, email ignored).
- They **cannot** redeem an *email-constrained* link (redeem passes
  `emailVerified ? email : null`, so the SQL email check fails).

If a self-hoster wants email-invited onboarding to work for credential users,
that's a reason to prefer **Option B** (or to extend the invite gate to accept
"the address I authenticated with, even if unverified"). Flagging this as an
explicit sub-decision — it couples email/password to the invite UX.

### 4. Optional: admin/CLI account provisioning

When `AUTH_EMAIL_PASSWORD_SIGNUP=false` (closed registration), accounts must be
created some other way. Minimal approach: a `me`-side admin command that calls
better-auth's server API to create a user with a temporary password, printed
once for the admin to hand over (out-of-band, mirroring invites). Deferrable to
a later pass if v1 ships with open sign-up only.

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

Self-service email reset is **out of scope** (no sender). Options, in order of
effort:

1. **v1: none.** A locked-out user is reset by an operator. Document the
   `psql`/better-auth-API path. Acceptable for a small trusted self-host.
2. **Admin/CLI reset link (recommended follow-up).** Mirror invitations: an admin
   mints a one-time reset token server-side, the CLI prints
   `<server>/reset/<token>`, the admin shares it out-of-band, the user sets a new
   password on that page. Zero email, consistent with the invite model.
3. **Later, optional SMTP.** If `SMTP_*` (or a transactional-API key) is
   configured, wire better-auth's `sendResetPassword` to a real sender and expose
   a normal "Forgot password?" link. Purely additive.

---

## Security considerations

- **Password hashing** is better-auth's own (scrypt by default) into
  `accounts.password`; core api-key hashing (sha256) is unaffected — different
  subsystem.
- **Open sign-up exposure.** With `AUTH_EMAIL_PASSWORD_SIGNUP=true` on an
  internet-exposed instance, anyone reachable can create an account. Membership is
  still explicit (a new user has no spaces and no grants until invited/added), so
  the blast radius is limited, but doc guidance should steer public deployments to
  closed sign-up or keep OAuth-only.
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
- **Web:** `SignInCard` renders the right controls per bootstrap flags.
- **CLI:** e2e login still succeeds against a server with email/password on
  (guards the "CLI unchanged" claim). Likely a manual/harness check given the
  browser step.

---

## Open decisions (need a call before building)

1. **`email_verified` semantics for credential accounts** — Option A (gate trusts
   credential) vs Option B (`email_verified=true` on sign-up). Drives whether
   email-invite *discovery* works for password users.
2. **Registration policy default** — open self-service vs closed (admin-created).
3. **Password reset in v1** — none / admin-CLI-link / defer.
4. **Hosted policy** — keep memory.build strictly OAuth-only (flag always off in
   hosted config), or allow the flag everywhere.

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
| CLI | — | none (browser-based OAuth loopback is method-agnostic) |
| Docs | `SELF_HOST.md`, `.env.sample`, `AGENTS.md` auth summary | document the flag + no-email caveats |
</content>
</invoke>
