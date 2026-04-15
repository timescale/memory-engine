# me login

Authenticate with Memory Engine via OAuth.

## Usage

```
me login
```

## Description

Starts an OAuth device flow. You choose a provider (Google or GitHub), then the CLI displays a device code and opens your browser for authorization. Once you approve, the CLI stores your session token.

If your account has exactly one engine, it is automatically selected as the active engine and an API key is stored.

## Global Options

| Option | Description |
|--------|-------------|
| `--server <url>` | Server URL (overrides `ME_SERVER` env and stored default) |

## Notes

- Credentials are stored in `~/.config/me/credentials.yaml`.
- After login, use `me engine use` to select an engine if you have more than one.
- Use `me logout` to clear stored credentials.
