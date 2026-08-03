# Memory Engine Claude Code Plugin

This plugin supplies dormant Memory Engine plumbing for Claude Code:

- MCP registration runs exactly `me mcp`.
- The SessionStart hook provides the `AI_AGENT=claude` and `ME_PROJECT_DIR`
  harness contract to Claude shell commands.
- Capture hooks do nothing unless the machine-local capture profile explicitly
  enables Claude for the session directory.

The plugin has no server, space, API key, project, or capture configuration.
Runtime activation is configured separately through Memory Engine's local
harness policy.

## Install

Use the mechanical CLI installer:

```bash
me claude install
```

It registers the user-scoped Claude MCP entry `me mcp` and records that native
registration for safe removal. It does not prompt, log in, backfill sessions,
write repository configuration, or enable a Memory Engine feature.

## Uninstall

```bash
me claude uninstall
```

Only the registration recorded by Memory Engine is removed. Existing or changed
Claude configuration is retained.
