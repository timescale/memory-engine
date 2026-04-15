# me pack

Manage memory packs.

Memory packs are YAML files containing pre-built collections of memories. They provide structured knowledge that can be installed into any engine -- things like framework documentation, best practices, or domain-specific reference material.

## Commands

- [me pack validate](#me-pack-validate) -- validate a pack file
- [me pack install](#me-pack-install) -- install a pack into the active engine
- [me pack list](#me-pack-list) -- list installed packs

---

## me pack validate

Validate a memory pack file.

```
me pack validate <file>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `file` | yes | Pack YAML file to validate. |

Parses the YAML file and runs pack-specific constraint validation. Reports whether the pack is valid or lists the errors found.

---

## me pack install

Install a memory pack into the active engine.

```
me pack install <file> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `file` | yes | Pack YAML file to install. |

| Option | Description |
|--------|-------------|
| `--dry-run` | Preview what would happen without making changes. |
| `-y, --yes` | Skip confirmation for stale memory deletion. |

The install process:

1. Validates the pack file.
2. Connects to the active engine.
3. Finds existing memories from the same pack (by metadata).
4. Deletes stale memories from previous versions (with confirmation).
5. Creates all memories from the pack with `pack.*` tree prefixes and pack metadata.

### Example

```bash
# Preview installation
me pack install packs/typescript-best-practices.yaml --dry-run

# Install, auto-confirm stale deletion
me pack install packs/typescript-best-practices.yaml --yes
```

---

## me pack list

List installed packs in the active engine.

```
me pack list
```

Searches for all memories with pack metadata and displays a table grouped by pack name, showing name, version, and memory count.
