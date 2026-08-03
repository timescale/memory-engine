# Harness Integrations - Shared Contracts

Status: **frozen implementation contract** for the harness-integrations
rework. Contributor-facing; not published to `docs.memory.build/`.

This document resolves the four coordination seams in
`HARNESS_INTEGRATIONS_REQUIREMENTS.md` section 11. Workstreams may implement
against these interfaces without reaching into another workstream's provider
adapter or config parser.

## 1. Ownership and module layout

Add these modules under `packages/cli/`:

```
harness/
  registry.ts       # supported harness metadata, detection, install facade
  installations.ts  # installations.yaml schema and read/write/update helpers
local-config.ts     # config.yaml harness-profile schema, resolver, writers
```

Existing files keep these responsibilities:

- `credentials.ts` continues to own human CLI credential/server/active-space
  resolution. It must not import `local-config.ts` to retarget a user command.
- `harness-contract.ts` remains the sole definition of `AI_AGENT` and
  `ME_PROJECT_DIR`.
- Provider adapters remain responsible for their native config mutation, but
  must report the artifacts they own through `harness/registry.ts`.

Dependency direction is one-way:

```
commands -> harness/registry -> harness/installations
commands -> local-config
provider adapters -> harness/registry types
credentials (human CLI) -> no local-config dependency
```

`local-config.ts` may import the `HarnessName` type from `harness/registry.ts`.
The registry must not import `local-config.ts`.

## 2. Canonical harness registry

### 2.1 Names

`HarnessName` is the only supported-harness identifier type:

```ts
export const HARNESS_NAMES = [
  "claude",
  "opencode",
  "codex",
  "gemini",
] as const;

export type HarnessName = (typeof HARNESS_NAMES)[number];
```

The serialized config keys, `AI_AGENT` values, CLI arguments, and
`installations.yaml` keys use these lowercase names. Display names are registry
metadata only:

| Name | Display name | Binary |
| --- | --- | --- |
| `claude` | Claude Code | `claude` |
| `opencode` | OpenCode | `opencode` |
| `codex` | Codex CLI | `codex` |
| `gemini` | Gemini CLI | `gemini` |

### 2.2 Registry API

```ts
export interface HarnessDescriptor {
  name: HarnessName;
  displayName: string;
  binary: string;
  detect(): boolean;
  install(): Promise<HarnessInstallResult>;
  uninstall(record: HarnessInstallation): Promise<HarnessUninstallResult>;
}

export interface HarnessInstallResult {
  artifacts: InstallationArtifact[];
  messages: string[];
}

export interface HarnessUninstallResult {
  removed: InstallationArtifact[];
  retained: InstallationArtifact[];
  messages: string[];
}

export function getHarness(name: HarnessName): HarnessDescriptor;
export function parseHarnessName(value: string): HarnessName;
export function detectInstalledHarnesses(): HarnessDescriptor[];
export function isHarnessInstalled(name: HarnessName): boolean;
export async function installHarness(name: HarnessName): Promise<void>;
export async function uninstallHarness(
  name: HarnessName,
  options?: { purge?: boolean },
): Promise<void>;
```

`installHarness` is idempotent. It invokes the adapter, then atomically replaces
that harness's inventory record with the returned artifacts. It may refresh an
already-installed ME artifact, but must not replace unrelated provider config.

`uninstallHarness` reads the recorded inventory. No record is a successful
no-op. The adapter removes only the artifacts described by that record, then
removes the inventory record. It must not discover-and-delete unrecorded items
named `me`, because they could predate this feature or belong to a user.

`--purge` is handled by the aggregate command layer after the selected adapters
succeed. It removes only `cli`, `mcp`, and `capture` selections for that harness
from `defaults` and every directory profile. It does not remove a profile that
still contains another harness or any enabled surface for another harness.

### 2.3 Dispatcher command

Every new install registers this exact stable command for MCP:

```
me mcp
```

The command intentionally contains no server, space, API key, scope, or
project path. The dormant dispatcher resolves all activation at runtime from
the local config and existing credential state. No installation writes a
credential or a per-repository configuration file.

The provider adapter must separately install its minimum native hook/plugin
plumbing needed to inject the harness contract and run dormant capture. The
hook/plugin itself must make no network call or memory write unless the resolved
capture profile selects that harness.

## 3. Deployment inventory: `installations.yaml`

Path: `~/.config/me/installations.yaml` (respect `XDG_CONFIG_HOME` in the same
way as `credentials.ts`). This file is ME-managed. It is neither a policy input
nor a credential store.

### 3.1 Serialized schema

```yaml
version: 1
harnesses:
  claude:
    installed_at: "2026-08-03T14:00:00.000Z"
    me_version: "0.0.0"
    artifacts:
      - kind: mcp-cli
        server_name: me
        scope: user
      - kind: plugin
        marketplace: memory-engine
        plugin: memory-engine@memory-engine
```

The formal TypeScript representation is:

```ts
export interface InstallationsFile {
  version: 1;
  harnesses: Partial<Record<HarnessName, HarnessInstallation>>;
}

export interface HarnessInstallation {
  installed_at: string; // ISO-8601 UTC timestamp
  me_version: string;
  artifacts: InstallationArtifact[];
}

export type InstallationArtifact =
  | {
      kind: "mcp-cli";
      server_name: "me";
      scope?: "user" | "project";
    }
  | {
      kind: "mcp-json";
      path: string; // absolute canonical path
      server_name: "me";
    }
  | {
      kind: "plugin";
      marketplace: string;
      plugin: string;
    }
  | {
      kind: "file";
      path: string; // absolute canonical path
      sha256: string; // bytes written by this install
    }
  | {
      kind: "json-hook";
      path: string; // absolute canonical path
      event: string;
      command: string;
    };
```

Artifact semantics:

- `mcp-cli`: uninstall through the provider's native `mcp remove me` command,
  using the recorded scope when supported.
- `mcp-json`: remove only the `mcp.me` entry from the recorded JSON file. Leave
  the file and all other entries intact. If the entry no longer describes the
  dormant dispatcher command, retain it and report why instead of deleting it.
- `plugin`: uninstall exactly the recorded plugin reference. Do not remove a
  marketplace unless its provider has a native operation that proves it has no
  other installed users.
- `file`: delete only when its current SHA-256 equals the recorded hash. A
  changed file is user-owned from that point and is retained with a message.
- `json-hook`: remove exactly the entry matching event + command. Retain the
  config file and unrelated hook entries.

The registry must record every artifact it mutates. An adapter must not mutate
an artifact type that this union cannot express; extend this union first.

### 3.2 Read/write behavior

```ts
export function getInstallationsPath(): string;
export function readInstallations(): InstallationsFile;
export function getInstallation(
  harness: HarnessName,
): HarnessInstallation | undefined;
export function writeInstallation(
  harness: HarnessName,
  installation: HarnessInstallation,
): void;
export function removeInstallation(harness: HarnessName): void;
```

- Missing file means `{ version: 1, harnesses: {} }`.
- Invalid YAML or wrong version is a loud error with the file path; never
  silently overwrite an unreadable deployment inventory.
- Writes are atomic: write a sibling temporary file with mode `0600`, then
  rename it. The config directory remains mode `0700`.
- `installed_at` is the successful completion time; `me_version` comes from the
  running CLI version.
- A failed install must not replace a valid old record. An adapter that leaves
  partially-created artifacts reports them so the command can either roll them
  back before failure or persist a record that permits a safe retry/uninstall.

## 4. Local config contract: `config.yaml`

`config.yaml` combines two intentionally separate concerns:

1. Existing **human CLI state**: `default_server`, `servers.*.active_space`,
   and `server_whitelist` remain owned by `credentials.ts`.
2. New **harness policy**: `version`, `defaults`, and `directories` are owned
   by `local-config.ts`.

Writers must preserve the other concern's keys. Neither module may rewrite the
whole YAML document from a narrow type that discards unknown top-level keys.

### 4.1 Types

```ts
export type HarnessSelection = Partial<Record<HarnessName, boolean>>;

export interface McpSurface {
  enabled: boolean;
  server?: string;
  space?: string;
  harnesses: HarnessSelection;
}

export interface CaptureSurface {
  enabled: boolean;
  server?: string;
  space?: string;
  tree?: string;      // directory profiles only
  tree_root?: string; // defaults only
  harnesses: HarnessSelection;
}

export interface CliSurface {
  server?: string;
  space?: string;
  harnesses: HarnessSelection;
}

export interface HarnessProfile {
  mcp?: McpSurface;
  capture?: CaptureSurface;
  cli?: CliSurface;
}

export interface LocalConfig {
  version: 1;
  defaults?: HarnessProfile;
  directories: Record<string, HarnessProfile>;
}
```

Validation at parse and write time:

- A selected `mcp` or `capture` surface has `enabled: true`, a nonempty
  `server`, and at least one `harnesses.<name> === true`.
- Selected `capture` requires `space`. A defaults capture profile has exactly
  `tree_root`; a directory capture profile has exactly `tree`.
- A selected `cli` surface has a nonempty `server` and at least one selected
  harness. Its `space` is optional.
- Disabled/missing surfaces never require their other fields.
- `tree` and `tree_root` may not coexist in one capture surface.
- Directory keys are absolute, canonical paths. A trailing slash is removed
  except for `/`.
- Unknown top-level profile keys and unknown harness names are errors. Unknown
  unrelated `config.yaml` top-level keys remain preserved by writers.

`space` omitted from MCP means MCP multi-space mode. `space` omitted from CLI
means that a selected harness CLI call has a server override only and continues
through the normal space chain (explicit flag, `ME_SPACE`, then `me use`).

### 4.2 Resolver API

```ts
export interface ResolvedSurface<T> {
  source: "directory" | "defaults" | "disabled";
  profile_path?: string; // canonical matched directory, if source=directory
  value?: T;
}

export interface ResolvedHarnessProfile {
  cwd: string;
  profile_source: "directory" | "defaults";
  profile_path?: string;
  mcp: ResolvedSurface<McpSurface>;
  capture: ResolvedSurface<CaptureSurface>;
}

export function resolveHarnessProfile(cwd: string): ResolvedHarnessProfile;
export function resolveMcpProfile(cwd: string): ResolvedSurface<McpSurface>;
export function resolveCaptureProfile(
  cwd: string,
): ResolvedSurface<CaptureSurface>;
export function resolveHarnessCliProfile(
  cwd: string,
  harness: HarnessName,
): ResolvedSurface<CliSurface>;
```

Resolution is exact and non-merging:

1. Canonicalize cwd (`realpath`; lexical absolute normalization when the path
   does not yet exist).
2. Select the segment-aware longest ancestor from `directories`.
3. If one matches, use that **whole profile**. A missing surface is disabled;
   `defaults` is not consulted.
4. Otherwise use the whole `defaults` profile. A missing surface is disabled.
5. For every surface, a harness not explicitly selected (`=== true`) is
   disabled for that harness.

`resolveHarnessCliProfile` is called only after the CLI confirms a known
`AI_AGENT` harness contract. If the selected profile does not opt into that
harness, it returns `{ source: "disabled" }`; its caller then uses the existing
human CLI resolution chain. There is intentionally no `resolveCliProfile(cwd)`
for a user command.

The MCP dispatcher obtains cwd from provider context, then `process.cwd()`,
then `ME_PROJECT_DIR`; no cwd means it passes a synthetic no-match path to the
resolver and gets `defaults`. Capture hooks use `ME_PROJECT_DIR` as their
primary discovery anchor.

### 4.3 Writer API

```ts
export function readLocalConfig(): LocalConfig;
export function writeDefaults(profile: HarnessProfile): void;
export function writeDirectoryProfile(
  directory: string,
  profile: HarnessProfile,
): void;
export function removeHarnessFromProfiles(harness: HarnessName): void;
```

- `writeDefaults` and `writeDirectoryProfile` validate before writing and
  always write the complete supplied profile. They do not merge it with an old
  profile.
- `writeDirectoryProfile` canonicalizes the supplied directory before storing
  it.
- `removeHarnessFromProfiles` removes one harness selection from all three
  surfaces and removes a surface only when it no longer selects any harness.
  It deletes a directory profile only when it has no remaining surfaces.
- The `me init` wizard builds a complete `HarnessProfile` then calls one writer;
  it does not mutate YAML itself.

## 5. Runtime boundary

The dormant dispatcher has three consumers, each with a strict gate:

| Consumer | Context test | Resolver | Inactive behavior |
| --- | --- | --- | --- |
| MCP `tools/list` | provider identity known | `resolveMcpProfile` | return `[]` |
| Capture hook | hook knows provider name | `resolveCaptureProfile` | exit success; no write/network |
| `me` from harness shell | `AI_AGENT` is a `HarnessName` | `resolveHarnessCliProfile` | use human CLI resolution |

The standard user CLI must not import or resolve a directory profile. A human
running `me` from an activated project, including with `ME_PROJECT_DIR` set but
without a known `AI_AGENT`, uses the current flags -> `ME_*` -> `me use` ->
`default_server` sequence.

## 6. Required focused tests

- `harness/registry.test.ts`: names, parse errors, detection, aggregate
  install/uninstall dispatch, and `--purge` profile cleanup.
- `harness/installations.test.ts`: schema validation, atomic writes, malformed
  inventory failure, and artifact-preserving uninstall behavior.
- `local-config.test.ts`: path canonicalization, segment-aware longest match,
  strict no-inheritance, scope-specific capture tree validation, and harness
  gates on all surfaces.
- CLI integration tests: user CLI ignores directory profiles; selected harness
  CLI uses its profile; unselected harness CLI falls back to human CLI.
- Provider adapter tests: every mutation returns an artifact that can precisely
  undo it without affecting unrelated provider config.

## 7. Change control

Changing a serialized field, public type, artifact kind, or resolver behavior
in this document requires updating:

1. `HARNESS_INTEGRATIONS_REQUIREMENTS.md`
2. this document
3. the corresponding focused tests
4. the durable decision memory under
   `/share/projects/memory_engine/design/harness-integrations/decisions/`

Do not add compatibility shims before a real serialized installation or config
format has shipped.
