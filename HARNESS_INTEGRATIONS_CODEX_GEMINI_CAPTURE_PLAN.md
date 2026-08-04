# Codex and Gemini Capture Plan

## Goal

Add dormant, machine-local-policy-gated live transcript capture for Codex and
Gemini. Installation adds only native hook plumbing; no transcript is read or
written until the matched `capture` profile enables the provider.

This plan deliberately reuses the existing importer pipeline. Do not introduce
a new shared hook-input or capture-contract module unless repeated provider
code proves it necessary.

## Existing Shared Pipeline

The common write path already exists in `packages/cli/importers/index.ts`:

- `importTranscriptFile()` parses a provider transcript and delegates to
  `importTranscriptSession()`.
- `importTranscriptSession()` creates idempotent, per-message memories with
  stable source metadata and importer-version reconciliation.
- Destination options are already shared: `tree`, `treeRoot`, session node
  name, transcript mode, dry-run, and verbosity.

Claude uses the file-based form from its hook. OpenCode resolves a session from
its local store and calls `importTranscriptSession()` directly. Codex should use
the Claude shape. Gemini should use it after its transcript format is verified.

## Codex

### Implementation

1. Expose the existing single-session file parser through
   `codexImporter.parseFile` in `packages/cli/importers/codex.ts`. A
   hook-provided transcript must normalize exactly like `me import codex`.
2. Add `me codex hook` in `packages/cli/commands/codex.ts`.
   - Read the native hook payload from stdin.
   - Accept the explicit hook event name as an option.
   - Resolve `capture` policy from the payload `cwd`.
   - Exit successfully without work unless `capture.enabled` and
     `capture.harnesses.codex` are both true.
   - Require a usable server, space, credential, and `transcript_path` before
     calling `importTranscriptFile()`.
   - Be fail-open: malformed input, parse failures, unavailable credentials,
     and write errors are diagnostic-only and exit zero.
3. Extend `packages/cli/codex/integration.ts` to retain the existing
   `PreToolUse` environment hook and add separate dormant capture hooks for
   `Stop` and `SessionEnd`, each invoking `me codex hook --event <name>`.
4. Record the new hook entries as owned installation artifacts. Reinstall and
   uninstall must remain surgical and preserve unrelated hooks.

### Behavior and Risk

- `Stop` is the normal incremental capture point. `SessionEnd` is a best-effort
  final flush, not the sole correctness mechanism, because Codex has a short
  SessionEnd hook timeout and no async hook execution.
- Keep `me import codex` as the historical/backfill path.
- Codex documents `transcript_path` as a convenience interface whose format may
  change. The parser must use strict format detection, versioned fixtures, and
  fail safely when the shape is unknown.
- Do not automate Codex `/hooks` trust approval. Document the one-time manual
  approval requirement.

### Tests

- File parser equivalence with bulk Codex import for current and legacy JSONL
  fixtures.
- Hook behavior for disabled/unselected policy, malformed payload, missing
  transcript path, missing credentials, parser error, and write error.
- Repeated Stop and SessionEnd events are idempotent.
- Installation, reinstallation, and uninstall preserve unrelated Codex hooks.
- User-approved manual validation of actual Stop and SessionEnd payloads,
  readable transcript paths, and flush timing.

## Gemini Discovery Prerequisite

Gemini has no importer or verified local transcript fixture in this repository.
Before implementing a parser, collect sanitized real payload and transcript
samples for:

- `AfterAgent` after a normal response;
- `SessionEnd`;
- at least one tool-use turn; and
- a resumed session when supported.

This requires explicit user approval before running a live Gemini harness or
smoke test because it can spend model tokens. Preserve field shape, ordering,
IDs, timestamps, tool records, and transcript-path behavior while removing
secrets and project-specific content.

## Gemini

### Implementation

1. Add `geminiImporter` and fixture-driven parsing only after the discovery
   prerequisite confirms a usable transcript format. Do not promise a bulk
   historical importer until a stable way to enumerate prior Gemini sessions is
   verified.
2. Add `me gemini hook` in `packages/cli/commands/gemini.ts`.
   - Read the native hook payload from stdin.
   - Resolve `capture` policy from payload `cwd`.
   - Gate on `capture.enabled` and `capture.harnesses.gemini`.
   - Incrementally import the transcript through `importTranscriptFile()`.
   - Exit zero on all hook failures after concise diagnostics.
3. Extend `packages/cli/gemini/integration.ts` to retain the existing
   `BeforeTool` environment hook and add dormant capture hooks for `AfterAgent`
   and `SessionEnd`.
4. Track those hook entries as owned artifacts and preserve unrelated Gemini
   settings during reinstall and uninstall.

### Behavior and Fallback

- `AfterAgent` is the timely capture trigger; `SessionEnd` reconciles the final
  state. Gemini SessionEnd is best-effort and cannot be the sole capture path.
- Prefer transcript parsing for stable message IDs and full transcript fidelity.
- If transcript parsing is unavailable or unstable, evaluate an `AfterAgent`
  prompt/response fallback separately. It must define deterministic message IDs
  and must not conflict with later transcript imports before it is enabled.

### Tests

- Fixture-driven parser tests once the transcript format is known.
- The same policy-gating and fail-open command tests as Codex.
- Idempotency across repeated AfterAgent and SessionEnd delivery.
- Installation, reinstallation, and surgical uninstall tests for Gemini hooks.
- User-approved live validation of payload shape, transcript availability, and
  SessionEnd behavior.

## Init and Doctor Follow-up

- Do not expose Codex or Gemini in the `me init` capture selector until their
  corresponding runtime handler is implemented.
- Once each handler ships, extend `me doctor` to show whether its capture hook
  is installed, why capture is inactive, the resolved profile, and provider
  diagnostics. Codex diagnostics should mention manual `/hooks` approval.

## Verification

Run `./bun run check` while iterating and `./bun run check:full` before merge.
Do not run a live harness smoke test without explicit user approval.
