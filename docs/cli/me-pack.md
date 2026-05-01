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

Inserts use server-side `ON CONFLICT DO NOTHING`, so existing rows with the same id are left untouched. The command classifies and reports any skips:

- **Already present** -- id is already tagged with this pack name and version. A benign no-op (e.g. re-running install on an unchanged pack).
- **Conflict** -- id is held by something else (a different pack, a different version, or a non-pack memory). Surfaced as a warning and listed by id so a real collision isn't silently masked. Exit code remains `0`.

### Output

Text mode prints a multi-line summary:

```
✓ Installed pack 'foo' v2: 12 memories
    └ 5 stale removed (from previous version)
    └ 2 already present (skipped)
```

Pure re-installs of an unchanged version produce a single line:

```
✓ Pack 'foo' v2 already installed (15 memories present, no changes)
```

If any ids collide with non-pack memories, a warning follows the success line and lists the conflicting ids.

JSON mode (`--format json`) returns:

| Field | Description |
|-------|-------------|
| `pack` | Pack name. |
| `version` | Pack version. |
| `installed` | Memories actually inserted on this run. |
| `staleRemoved` | Previous-version memories deleted before insert. |
| `skipped` | Total memories skipped by `ON CONFLICT DO NOTHING`. |
| `skippedIdempotent` | Skipped because already present at this version. |
| `skippedConflict` | Skipped because the id is held by something not from this pack/version. |
| `skippedConflictIds` | Array of conflicting ids (only present when `skippedConflict > 0`). |

### Example

```bash
# Preview installation (predicts idempotent skips)
me pack install packs/typescript-best-practices.yaml --dry-run

# Install, auto-confirm stale deletion
me pack install packs/typescript-best-practices.yaml --yes
```

Dry-run output includes `wouldSkipIdempotent` (predicted from rows already at the target version) alongside `wouldInstall` and `wouldDeleteStale`. It does not predict conflicts with non-pack memories -- those only surface during the real install.

---

## me pack list

List installed packs in the active engine.

```
me pack list
```

Searches for all memories with pack metadata and displays a table grouped by pack name, showing name, version, and memory count.
