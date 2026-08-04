# me init

Configure Memory Engine's machine-local harness policy.

## Usage

```bash
me init <directory> [surface options]
me init --defaults [surface options]
```

`me init` writes only your local Memory Engine configuration. It never writes a
repository file or stores credentials. A directory profile applies to that
directory and its descendants; `--defaults` applies when no directory profile
matches.

Enable a surface by supplying its server and one or more selected harnesses:

```bash
me init . \
  --mcp-server https://api.memory.build \
  --mcp-harness claude \
  --capture-server https://api.memory.build \
  --capture-space abc123def456 \
  --capture-tree share/projects/demo \
  --capture-harness claude
```

Available surfaces:

- MCP: `--mcp-server`, `--mcp-space` or `--mcp-multi-space`, and repeatable
  `--mcp-harness`.
- Capture: `--capture-server`, `--capture-space`, directory `--capture-tree`
  or default `--capture-tree-root`, and repeatable `--capture-harness`.
- Harness-shell CLI targeting: `--cli-server`, optional `--cli-space`, and
  repeatable `--cli-harness`.

Use [`me doctor`](me-doctor.md) to inspect the profile that applies to a
directory.
