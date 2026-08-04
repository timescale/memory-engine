# me doctor

Inspect the machine-local harness policy that applies to a directory.

## Usage

```bash
me doctor [directory]
```

With no argument, `me doctor` resolves from the same anchor the dispatcher and
capture hooks use — `ME_PROJECT_DIR` when set, otherwise the current directory.
An explicit `[directory]` overrides that anchor. The command reports:

- **Anchor** — the raw anchor and where it came from (`argument`,
  `ME_PROJECT_DIR`, or `cwd`), plus the canonical (symlink-resolved) path.
- **Profile** — whether a directory profile matched (and which one) or it fell
  back to `defaults`.
- **MCP** and **Capture** — active or inactive. When inactive, it explains why:
  the surface is absent from the matched profile, `enabled` is `false`, or it is
  enabled but selects no harness. When active, it lists the selected harnesses,
  server, space (or multi-space for MCP), and capture `tree` / `tree_root`.
- **CLI** — whether the harness-context routing surface is configured, its
  selected harnesses, and its server/space.
- **Harness context** — for the current shell only: if a known harness set
  `AI_AGENT`, whether CLI-in-harness routing applies (and its target) or falls
  back to user CLI. A plain user shell reports that user CLI is never retargeted
  by directory profiles.
- Any sanitized unrecognized Codex hook payload shapes recorded by the harness
  adapter.

Use `--json` or `--yaml` for structured output.
