# PR #156 — device-flow review follow-ups

## Medium
- [x] 1. `--switch` is ignored on the device branch — `me login --device --switch`
      prints "you'll sign in again" but the /device page claims the code with the
      existing browser session, so it can authorize the wrong account. Implement
      switching for device flow, or reject the `--device --switch` combo.
      (login.ts:139)
- [x] 2. The device-code endpoint is an unauthenticated DB-write gated only by the
      public `me-cli` client id — no rate limiting → sustained DB/WAL load. Add
      per-IP/client rate limiting via `onDeviceAuthRequest` or route middleware.
      (betterauth.ts:279)
- [x] 3. `bearer()` with default `requireSignature: false` makes every plaintext
      `auth.sessions.token` usable directly as an API bearer (not just device
      sessions) → a sessions-table/backup disclosure becomes sufficient to
      authenticate. Avoid accepting unsigned session tokens globally (signed
      device credential + `requireSignature: true`, or a narrower path).
      (betterauth.ts:300)
- [x] 4. `SignInCard` on /device leaves `errorCallbackURL` unset (defaults to
      `window.location.pathname`), so a provider/verified-email error returns to
      `/device` without `user_code` — a retry can't resume. Preserve the full
      device URL (with code) on the error callback too. (DeviceVerificationPage.tsx:185)
- [x] 5. `pollDeviceToken` treats a rejected `fetch` as fatal and has no per-request
      abort deadline (RFC 8628 §3.5 wants transient failures retried with reduced
      frequency; a hung connection can outlive `expiresIn`). Retry transient
      failures with backoff; bound each request by the remaining lifetime.
      (device.ts:158)

## Low
- [x] 6. `me login --device` awaits `openBrowser`, which can block until the
      launcher/browser exits (some `xdg-open` combos), delaying polling until the
      code may expire. Make browser launch fire-and-forget / independently bounded.
      (login.ts:316)
- [x] 7. Verification URL is built by string concat (`${baseURL}/device`) → `//device`
      when `API_BASE_URL` has a trailing slash, which the SPA won't match. Use
      `new URL("/device", baseURL)` / normalize. (betterauth.ts:278)
- [x] 8. Device-code input displays uppercase via CSS but `claim()` sends the raw
      typed/pasted value; Better Auth strips dashes then does a case-sensitive
      lookup, so lowercase/mixed-case codes look right but fail. Normalize to
      uppercase before claim/approve/deny. (DeviceVerificationPage.tsx:83 / 85 —
      Copilot + human, same issue)
- [x] 9. Device-code input has only placeholder text — add a real label / `aria-label`
      for screen readers. (DeviceVerificationPage.tsx:213)

## Verify (likely non-issue)
- [ ] 10. Copilot: `React.ReactNode` used without importing the `React` namespace
      "will fail typechecking." In practice `web:typecheck` passes (global
      `@types/react`), and existing components (e.g. InviteLandingPage) use the
      same pattern. Verify; optionally switch to `import type { ReactNode }` for
      consistency with SignInCard. (DeviceVerificationPage.tsx:18)
