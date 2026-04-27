# me version

Show CLI and server versions and check compatibility.

## Usage

```
me version [--no-server]
```

## Description

Prints the running CLI version, then probes the configured server's
`GET /api/v1/version` endpoint and prints:

- the server's version,
- the oldest client version the server accepts (`minClientVersion`),
- a confirmation that the two are compatible.

If the server is too old for this CLI, or the CLI is too old for the
server, the command prints an explanatory error and exits with status
`1`. This makes `me version` suitable as a CI gate before running other
`me` commands.

The `me login` command runs the same compatibility check internally
before starting the OAuth flow, so users see a clean upgrade prompt
instead of obscure errors mid-login.

## Options

| Option | Description |
|--------|-------------|
| `--no-server` | Skip the server probe; print only the local CLI version. |

## Global Options

| Option | Description |
|--------|-------------|
| `--server <url>` | Server URL to probe (overrides `ME_SERVER` env and stored default). |
| `--json` | Output as JSON. |
| `--yaml` | Output as YAML. |

## Examples

Check the configured server:

```
me version
```

Check a specific server:

```
me version --server https://api.memory.build
```

Local-only output (e.g. on an air-gapped machine):

```
me version --no-server
```

JSON output for scripts and CI:

```
me version --json
```

## Notes

- `me --version` (with two dashes) prints only the CLI version, like
  most CLIs. `me version` (no dashes) is the richer diagnostic command
  that also probes the server.
- If the server reports the CLI is too old, follow the upgrade
  instructions in the error message. If the server is too old for this
  CLI, contact whoever runs the server.
