---
title: Harness Integrations
tags: [harnesses, mcp, capture, configuration, cli]
---

# Harness Integrations

Memory Engine integrates with Claude Code, OpenCode, and Codex CLI. The
integration model keeps provider-specific installation separate from activation
and credentials. Installing support for a harness does not enable Memory Engine
in every project or create a new execution identity.

## Layers

Each integration has two independent layers:

| Layer | Scope | Responsibility |
| --- | --- | --- |
| Installation | User-global | Register provider-specific MCP, hook, and plugin plumbing owned by Memory Engine. |
| Activation | Machine-local and directory-scoped | Select which harnesses receive MCP, capture, and CLI-routing behavior. |

Installers create dormant artifacts without a server, space, credential, or
project-specific policy. They record the artifacts they own. Uninstall removes
only recorded, unchanged artifacts; `--purge` additionally removes the harness
from activation profiles.

## Machine-local policy

Harness policy lives in the normal non-secret configuration file,
`~/.config/me/config.yaml` (or its XDG equivalent). It is not repository
configuration and never persists API keys.

The policy has fallback defaults and canonical absolute directory profiles. The
longest matching directory profile wins. A matched directory profile replaces
defaults as a complete profile: a surface omitted from that profile is disabled,
not inherited. This prevents a broad default from unexpectedly activating a
harness behavior in a more specific project.

Each profile configures three independent surfaces:

| Surface | Purpose |
| --- | --- |
| MCP | Enable managed Memory Engine tools for selected harnesses and select their server and optional space. |
| Capture | Import selected harness sessions into a configured space and tree. |
| CLI routing | Select the server and optional space for `me` commands run by selected harnesses. |

Every enabled surface explicitly selects its harnesses. Capture also requires a
server, space, and destination tree. `me init` writes these profiles; `me doctor`
shows the resolved profile, active surfaces, and their source.

## Runtime contract

Every provider adapter injects the same inert context into shell commands run by
its harness:

```text
AI_AGENT=<claude|opencode|codex>
ME_PROJECT_DIR=<harness session directory>
```

`AI_AGENT` identifies a recognized harness for policy lookup. `ME_PROJECT_DIR`
is the directory anchor used to resolve the machine-local profile. Neither value
authenticates a principal, changes credentials, or enables repository
configuration discovery.

Only a plain `me` command running under this recognized harness contract applies
the CLI-routing surface. Commands run in a user's ordinary shell continue using
normal flags, `ME_*` environment variables, and global CLI configuration.

## MCP and capture

Managed MCP registrations run `me mcp --harness <name>`. The MCP command resolves
the matching directory policy before resolving credentials. A missing, disabled,
or unselected managed harness starts without Memory Engine tools. A bare `me mcp`
invocation remains the separate manual mode and is not policy-gated.

Capture is opt-in and best-effort. Hooks resolve the capture surface from the
harness project directory, return successfully when capture is disabled or
fails, and import through the normal idempotent session-import path. Capture must
not interrupt an interactive coding session.

## Credentials and boundaries

Harnesses run as the credential they actually receive. There is no agent
impersonation, `--as-agent` mode, or access header that changes the principal.
Credential selection remains normal: explicit flags and `ME_*` environment values
override saved targeting, and API keys are supplied explicitly rather than stored
in harness policy.

For a deliberately restricted harness, run it in an environment that does not
also contain the user's broader credentials and provide a restricted personal API
key or a service-account key. Policy routing is convenience and activation
control, not a credential-security boundary.

## Provider adapters

| Harness | Adapter document | MCP | Capture | Shell contract |
| --- | --- | --- | --- | --- |
| Claude Code | [Claude adapter](harnesses/claude.md) | Plugin-provided | Stop and SessionEnd hooks | SessionStart writes the sourced Claude environment file. |
| OpenCode | [OpenCode adapter](harnesses/opencode.md) | Managed local entry | Idle and deleted session events | Plugin `shell.env` hook. |
| Codex CLI | [Codex adapter](harnesses/codex.md) | Managed local entry | Stop and SessionEnd hooks | PreToolUse Bash command rewrite. |

Provider adapters own only the mechanics needed to satisfy this shared contract.
Provider setup instructions and command reference remain in `docs/`.
