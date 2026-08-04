# me doctor

Inspect the machine-local harness policy that applies to a directory.

## Usage

```bash
me doctor [directory]
```

The command reports the canonical directory, whether a directory or default
profile matched, and the active MCP and capture surfaces. It also reports any
sanitized unrecognized Codex or Gemini hook payload shapes recorded by the
harness adapters.

Use `--json` or `--yaml` for structured output.
