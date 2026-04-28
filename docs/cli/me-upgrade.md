# me upgrade

Upgrade the `me` CLI binary from the latest GitHub release.

## Usage

```bash
me upgrade [--check] [--force] [--version <tag>]
```

## Description

`me upgrade` checks the latest `timescale/memory-engine` GitHub release. If the
release version is newer than the running CLI version, it downloads the matching
platform binary, verifies its `.sha256` checksum, applies the same macOS signing
fixups as `install.sh`, and replaces the running `me` executable.

The command must be run from an installed `me` binary. It refuses to replace a
non-`me` executable such as the Bun runtime used during local development.

## Options

| Option | Description |
| --- | --- |
| `--check` | Check whether an upgrade is available without installing. |
| `--force` | Reinstall the selected release even if it is not newer. |
| `--version <tag>` | Install a specific release tag instead of the latest release. The leading `v` is optional. |

## Examples

```bash
me upgrade
```

Check only:

```bash
me upgrade --check
```

Reinstall the current latest release:

```bash
me upgrade --force
```

Install a specific release:

```bash
me upgrade --version v0.2.2
```
