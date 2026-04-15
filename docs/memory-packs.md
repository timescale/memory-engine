# Memory Packs

Memory packs are YAML files containing pre-built collections of memories. They solve the cold-start problem: an empty memory system provides no value, so packs let you bootstrap with curated knowledge immediately.

## Installing a pack

```bash
# Validate first (offline, no server needed)
me pack validate packs/typescript-best-practices.yaml

# Install into the active engine
me pack install packs/typescript-best-practices.yaml
```

The install process:

1. Validates the pack file.
2. Finds existing memories from the same pack (by `meta.pack` metadata).
3. Deletes stale memories from previous versions.
4. Creates all new memories with deterministic IDs (making re-installs idempotent).

Use `--dry-run` to preview what would happen without making changes.

## Listing installed packs

```bash
me pack list
```

Shows all installed packs with name, version, and memory count.

## Pack format

A pack is a YAML array of memory objects with a header comment:

```yaml
# Pack: my-pack
# Version: 0.1.0
# Description: Best practices for TypeScript projects.
# ID prefix: 019b0300

- id: "019b0300-0001-7000-8000-000000000001"
  tree: "pack.typescript.naming"
  meta:
    pack:
      name: "my-pack"
      version: "0.1.0"
    topic: naming-conventions
  content: |
    Use camelCase for variables and functions,
    PascalCase for types and classes.

- id: "019b0300-0002-7000-8000-000000000002"
  tree: "pack.typescript.error_handling"
  meta:
    pack:
      name: "my-pack"
      version: "0.1.0"
    topic: error-handling
  content: |
    Always use typed errors. Avoid throwing plain strings.
```

### Requirements

- Every memory must have `meta.pack` with `name` and `version`.
- All memories in a file must share the same pack name and version.
- IDs must be valid UUIDv7.
- Content must be non-empty.
- Tree paths must be valid ltree paths.

### Deterministic IDs

Each pack claims a unique 8-character hex prefix. Memories use sequential suffixes:

```
<prefix>-NNNN-7000-8000-NNNNNNNNNNNN
```

The `7` at position 14 is the UUIDv7 version nibble. The `8` at position 19 is the RFC 9562 variant. This makes IDs deterministic and re-imports idempotent.

### Tree conventions

Packs typically use the `pack.*` tree prefix:

```
pack.<pack-name>.<topic>
```

This keeps pack content organized separately from user-created memories.

## Upgrading a pack

When you install a newer version of a pack, the old version's memories are automatically deleted and replaced. This is safe because pack IDs are deterministic -- the system knows exactly which memories belong to which pack version.

```bash
# Install v0.2.0 (automatically removes v0.1.0 memories)
me pack install packs/typescript-best-practices-v0.2.0.yaml
```

## Writing your own pack

1. Choose a unique ID prefix (8 hex characters).
2. Create a YAML file with the pack header and memory array.
3. Validate with `me pack validate`.
4. Install with `me pack install`.

See the `packs/` directory in this repository for examples.
