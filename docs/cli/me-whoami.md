# me whoami

Show current identity and active space.

## Usage

```
me whoami
```

## Description

Calls the user endpoint (`whoami`) and displays your name, email, principal ID, server URL, and active space.

Returns an error if you are not logged in. Set or change the active space with [`me space use`](me-space.md#me-space-use).

## Global Options

| Option | Description |
|--------|-------------|
| `--server <url>` | Server URL (overrides `ME_SERVER` env and stored default) |
| `--json` | Output as JSON |
| `--yaml` | Output as YAML |
