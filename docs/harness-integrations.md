# Harness Integrations

Memory Engine has first-class integrations for [Claude
Code](https://docs.anthropic.com/en/docs/claude-code),
[OpenCode](https://opencode.ai/), and [Codex
CLI](https://developers.openai.com/codex/cli/). An integration gives the coding
harness access to Memory Engine tools through MCP. You can also opt in to session
capture and configure where `me` commands run by the harness connect. For other
MCP-compatible coding harnesses, see [MCP Integration](mcp-integration.md).

Install each harness integration once for your user account. Then configure it
machine-wide through fallback defaults, or for one directory and its descendants.
`me init` is the guided tool for that configuration.

Integrations have two separate layers:

1. **Install** registers user-global, provider-specific plumbing for a coding
   harness.
2. **Initialize** enables Memory Engine for a directory through your
   machine-local policy.

This separation lets you install an integration once, then choose where and how
it is active without committing configuration or credentials to a repository.

## Quick Setup

For the usual per-repository setup, run this from the repository root:

```bash
me init
```

Quick setup:

- signs you in when needed;
- selects a space, automatically when you have only one;
- enables MCP tools and `me` command routing for every detected coding harness;
- offers optional session capture; and
- offers to install missing detected integrations.

When capture is enabled, its default destination is
`/share/projects/<repository>`. Enter `~/projects/<repository>` at the prompt
to keep captures private.

Run `me doctor` afterwards to inspect the profile that applies to the current
directory. Use `me init --verbose` when you need to configure MCP, capture, and
CLI routing independently.

### Import Existing Sessions

To import sessions created before capture was enabled, run `me import claude`,
`me import codex`, or `me import opencode`. See [Agent session
imports](cli/agent-session-imports.md) for options, destination trees, and
idempotent re-imports.

## Install And Uninstall

Use the aggregate commands to manage detected harnesses:

```bash
me install
me uninstall
```

Or target a harness directly:

```bash
me install claude
me install opencode codex
me uninstall codex
```

Installation writes only the provider's user-global integration artifacts. It
does not log in, persist an API key, select a space, enable capture, or write
repository configuration. The policy created by `me init` decides whether a
managed integration is active for a directory.

Memory Engine records the artifacts it creates. Uninstall removes recorded
artifacts when they are unchanged, and preserves unrecorded or modified provider
configuration for you to review manually. Add `--purge` to also remove the
selected harness from your saved activation profiles.

| Harness | Installation result | Additional step |
| --- | --- | --- |
| Claude Code | Managed plugin with MCP and capture plumbing | Restart Claude Code after installation |
| OpenCode | Managed MCP entry and generated plugin | Restart OpenCode after installation |
| Codex CLI | Managed MCP entry and user-global hooks | Approve hooks with `/hooks`; restart after environment changes |

See the provider references for details: [`me claude`](cli/me-claude.md),
[`me opencode`](cli/me-opencode.md), and [`me codex`](cli/me-codex.md).

## Machine-Local Configuration

By default, Memory Engine stores non-secret configuration in:

```text
~/.config/me/config.yaml
```

If `XDG_CONFIG_HOME` is set, Memory Engine uses `$XDG_CONFIG_HOME/me` instead.
The file holds your default server, active spaces, and harness policy. It does
not store API keys. Login sessions use your system keychain when available (or a
protected credentials file), and an API key is supplied only through
`ME_API_KEY` or an explicit command option.

The policy has two scopes:

- **Defaults** apply when no directory profile matches.
- **Directory profiles** apply to their directory and descendants. The most
  specific matching directory wins.

A matching directory profile is complete: omitted MCP, capture, or CLI routing
surfaces are disabled rather than inherited from defaults. This makes a
directory's behavior predictable.

## Policy Surfaces

Each profile can configure three independent surfaces:

- **MCP** controls which managed harnesses receive Memory Engine tools and the
  server and space they use.
- **Capture** controls whether supported harness sessions are imported and where
  they are stored.
- **CLI routing** controls the server and optional space for `me` commands that
  a selected harness runs. It never retargets commands you run in your own
  shell.

An illustrative directory profile looks like this:

```yaml
directories:
  /Users/me/work/acme-api:
    mcp:
      enabled: true
      server: https://api.memory.build
      space: acme123def456
      harnesses:
        codex: true
        opencode: true
    capture:
      enabled: true
      server: https://api.memory.build
      space: acme123def456
      tree: /share/projects/acme-api
      harnesses:
        codex: true
        opencode: true
    cli:
      server: https://api.memory.build
      space: acme123def456
      harnesses:
        codex: true
        opencode: true
```

Use `me init --verbose` instead of editing the file when you want guided
configuration. Use `me doctor [directory]` to see which profile and surfaces
are effective.

## Runtime Context And Overrides

Harness integrations provide `AI_AGENT` and `ME_PROJECT_DIR` to identify the
harness and its directory. These are runtime context for the integration, not
repository configuration.

For normal CLI commands, explicit flags and `ME_*` environment variables take
precedence over saved machine-local settings. Managed MCP processes also consult
the matching MCP policy: if the policy is disabled or does not select that
harness, the process starts without Memory Engine tools.

Manual `me mcp` usage is separate. It can be locked to one space with
`--space` or `ME_SPACE`, or run in multi-space mode without either. See [MCP
Integration](mcp-integration.md) for manual configuration.

## Headless And Codex Environments

On a headless host, sign in with a device code:

```bash
me login --device
```

For unattended use, provide a personal or service-account key through
`ME_API_KEY`. Codex forwards `ME_API_KEY`, `ME_SERVER`, and `ME_SPACE` to its
managed MCP process when those variables are present in Codex's environment; it
does not write their values to `~/.codex/config.toml`. Restart Codex after
changing those variables.

Codex hooks require one-time approval through `/hooks`. Memory Engine never
automates or bypasses that approval.

## Troubleshooting

Start with:

```bash
me doctor
me status
```

`me doctor` reports the resolved profile, active and inactive surfaces, the
directory anchor, and harness-specific MCP diagnostics. If an integration was
installed but remains inactive, verify that the profile selects that harness and
that the harness has been restarted.

See also [`me init`](cli/me-init.md), [`me install`](cli/me-install.md),
[`me uninstall`](cli/me-uninstall.md), and [`me doctor`](cli/me-doctor.md).
