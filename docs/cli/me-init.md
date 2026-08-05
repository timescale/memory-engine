# me init

Configure Memory Engine's machine-local harness policy.

## Usage

```bash
me init
me init <directory> [surface options]
me init --defaults [surface options]
me init --verbose
```

`me init` writes only your local Memory Engine configuration. It never writes a
repository file. If login is needed, it stores its OAuth session using the
normal `me login` credential handling. A directory profile applies to that
directory and its descendants; `--defaults` applies when no directory profile
matches.

## Quick setup

Run `me init` in an interactive terminal for the common setup. It is equivalent
to `me init .`: it configures the current directory, helps you sign in when
needed, selects your only space automatically (or defaults the picker to your
active space), and enables MCP plus harness-shell CLI routing for every detected
coding-agent harness. It uses `https://api.memory.build` unless `ME_SERVER` or
`--server` supplies a different server.

Quick setup asks whether session capture should be available. Capture is off by
default. If enabled, its tree defaults to `/share/projects/<repository>`; enter
`~/projects/<repository>` instead to keep captured sessions private. It also
offers to install missing detected harness integrations. Declining leaves the
profile ready for a later `me install <harness>`.

On success, `me init` prints the machine-local config path it updated and points
to `me init --verbose` for advanced setup.

See [Harness Integrations](../harness-integrations.md) for installation,
uninstallation, configuration storage, and runtime policy details.

## Verbose setup

Use `me init --verbose` to configure a profile step by step. The verbose wizard
asks whether to configure the current directory or fallback defaults, helps you
sign in when needed, offers to install detected harness integrations, and then
configures MCP, capture, and harness-shell CLI routing independently. If you
have no spaces, it can create a personal space; ordinary space pickers list
existing spaces only. `me init --defaults` also uses this full wizard.

The interactive wizard asks before replacing an existing profile. Flag-based
invocations are deterministic and replace the selected profile directly. The
resulting profile always contains explicit disabled surfaces, so a directory
profile never inherits an omitted surface from `defaults`.

Enable a surface by supplying its server and one or more selected harnesses:

```bash
me init . \
  --mcp-server https://api.memory.build \
  --mcp-harness claude \
  --capture-server https://api.memory.build \
  --capture-space abc123def456 \
  --capture-tree /share/projects/demo \
  --capture-harness claude
```

On a TTY, supplying surface flags without a scope prompts only for the scope;
the flags remain the complete, deterministic profile input. In a non-interactive
shell, supply explicit surface flags; quick setup requires an interactive
terminal.

Available surfaces:

- MCP: `--mcp-server`, `--mcp-space` or `--mcp-multi-space`, and repeatable
  `--mcp-harness`.
- Capture: `--capture-server`, `--capture-space`, directory `--capture-tree`
  or defaults `--capture-tree-root`, and repeatable `--capture-harness`. A
  defaults capture profile uses a per-project slug beneath `tree_root`.
- Harness-shell CLI targeting: `--cli-server`, optional `--cli-space`, and
  repeatable `--cli-harness`. This affects only `me` commands started by the
  selected harnesses, never commands you run in your own shell.

Use [`me doctor`](me-doctor.md) to inspect the profile that applies to a
directory.
