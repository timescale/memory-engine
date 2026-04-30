# memory packs

Pre-built knowledge and skills for [memory engine](https://memory.build) — install a YAML file, get instant value.

## What are memory packs?

A memory pack is a YAML file containing memories that you install with `me pack install`. No code, no plugins, no running processes.

Packs may contain a mix of:

- **Reference knowledge** — static content that's useful immediately after install
- **Skill instructions** — procedural content that teaches AI agents how to perform tasks

Memory Packs are Neo's "I know kung fu" for your agents.

## Quick start

```bash
# Validate a pack (no server needed)
me pack validate packs/git-history.yaml

# Install a pack into the active engine
me pack install packs/git-history.yaml

# Preview what would happen
me pack install packs/git-history.yaml --dry-run
```

## Available packs

| Pack | Description |
|------|-------------|
| [pack-authoring](pack-authoring.yaml) | How to write effective memory packs — skill memory structure, reference memory craft, organization, ID/versioning, and quality checklist |
| [skill-to-pack](skill-to-pack.yaml) | Convert Agent Skills (agentskills.io) into memory engine packs — format reference, conversion procedure, field mapping, and edge cases |
| [codebase-index](codebase-index.yaml) | Teaches agents to build a structural code index using Tree-sitter and filesystem watching — zero LLM cost, always current |
| [docs-to-pack](docs-to-pack.yaml) | Convert project documentation (Markdown, MDX, RST, OpenAPI) into memory packs |
| [git-history](git-history.yaml) | Teaches agents to backfill and incrementally sync git commit history into searchable memories |
| [github-content](github-content.yaml) | Extract GitHub issues, PRs, and releases into memory engine using the gh CLI |
| [build-postgres-queue](build_postgres_queue.yaml) | Comprehensive guide for designing and implementing task queues using PostgreSQL |

## Pack format

Each pack is a YAML file with a top-level envelope declaring pack identity, followed by a `memories` array:

```yaml
name: example_pack
version: "0.1.0"
description: "One-line summary of what this pack provides"
id-prefix: "019b0000"
format: 1
memories:
  - id: "019b0000-0001-7000-8000-000000000001"
    tree: "subtopic"
    meta:
      type: "skill"
    content: |
      # Example Skill — What This Does

      Instructions for an agent...
```

### Envelope fields

| Field | Required | Purpose |
|-------|----------|---------|
| `name` | Yes | ltree-safe identifier (`[a-z0-9_]+`) — used to construct tree paths at install |
| `version` | Yes | Semantic version string (e.g., `"0.1.0"`) |
| `description` | No | Human-readable summary |
| `id-prefix` | Yes | 8 lowercase hex characters — all memory IDs must start with this |
| `format` | Yes | Must be `1` |
| `memories` | Yes | Array of memory objects |

### Conventions

- **Envelope**: declares pack identity (`name`, `version`) — individual memories do not include `meta.pack`
- **IDs**: deterministic UUIDv7 with a fixed prefix per pack (makes re-installs idempotent)
- **Tree**: relative paths — auto-prefixed with `pack.<name>.` at install time
- **Content**: non-empty, self-contained, follows [memory best practices](https://memory.build)

Additional meta keys (like `type`, `topic`, etc.) are optional — add whatever makes your content discoverable and filterable.

### ID allocation

Each pack claims a unique UUIDv7 prefix. The canonical list lives in [`registry.yaml`](registry.yaml). Declare the same value in your pack's `id-prefix` envelope field — CI cross-checks both.

| Prefix | Pack |
|--------|------|
| `019b0001` | pack-authoring |
| `019b0002` | skill-to-pack |
| `019b0003` | codebase-index |
| `019b0004` | docs-to-pack |
| `019b0005` | git-history |
| `019b0006` | github-content |
| `019b0007` | build-postgres-queue |

When adding a new pack, claim the next available prefix in `registry.yaml` first, then generate IDs for it:

```bash
./bun run scripts/pack-uuids.ts 019b0008        # 10 IDs (default)
./bun run scripts/pack-uuids.ts 019b0008 25     # 25 IDs
./bun run scripts/pack-uuids.ts 019b0008 5 3    # 5 IDs starting at sequence 3
```

## Upgrading packs

`me pack install` handles version-aware upgrades automatically:

```bash
# First install: installs v0.1.0
me pack install packs/git-history.yaml
# Imported 1 memory, deleted 0 (pack: git_history@0.1.0)

# After updating the file to v0.2.0:
me pack install packs/git-history.yaml
# Imported 2 memories, deleted 1 (pack: git_history@0.2.0)
```

Old-version memories are automatically cleaned up. Memories that exist in both versions are updated in place (deterministic IDs).

## Contributing

1. Claim the next available ID prefix in [`registry.yaml`](registry.yaml)
2. Create your pack as a YAML file in `packs/`
3. Generate deterministic memory IDs with `./bun run scripts/pack-uuids.ts <prefix>`
4. Validate with `me pack validate packs/your-pack.yaml`
5. Run the cross-pack check: `./bun run scripts/validate-packs.ts`
6. Run the full repo check: `./bun run check`
7. Open a pull request

All packs must:

- Use the v2 envelope format (`name`, `version`, `id-prefix`, `format: 1`, `memories`)
- Use an ltree-safe pack name (`[a-z0-9_]+` — no hyphens)
- Use a unique ID prefix registered in `registry.yaml`
- Have non-empty, well-written content

## Validation & CI

Every pack is validated on push and pull request via GitHub Actions (see `.github/workflows/validate-packs.yml`). The workflow checks:

1. **Per-pack validation** — envelope fields, schema, IDs match `id-prefix`
2. **Cross-pack duplicate names** — no two packs may share a name
3. **Cross-pack ID prefix collisions** — no two packs may share an ID prefix
4. **Registry consistency** — every pack's `(name, id-prefix)` matches `registry.yaml`

### Local validation

```bash
# Single pack
me pack validate packs/git-history.yaml

# All packs + cross-pack + registry checks (same as CI)
./bun run scripts/validate-packs.ts
```

The cross-pack script reuses the parser from `packages/cli/parsers/pack.ts`, so the script and the `me` CLI can never drift.
