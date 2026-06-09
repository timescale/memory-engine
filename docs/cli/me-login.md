# me login

Authenticate with Memory Engine via OAuth.

## Usage

```
me login [space]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `space` | no | Space slug or name to make active after login. |

## Description

Starts an OAuth device flow. You choose a provider (Google or GitHub), the CLI displays a device code and opens your browser, and once you approve it stores your **session token**. Sessions are rolling: valid for 7 days and refreshed as you keep using the CLI.

If you pass a `space` argument, it becomes the active space. Otherwise, if you belong to exactly one space it's selected automatically; if you belong to several, run `me space use` to pick one. The active space is carried as the `X-Me-Space` header on subsequent commands.

Login also runs the same version compatibility check as `me version` before opening the browser, so an out-of-date CLI gets a clean upgrade prompt instead of failing mid-flow.

## Global Options

| Option | Description |
|--------|-------------|
| `--server <url>` | Server URL (overrides `ME_SERVER` env and stored default) |

## Notes

- The session token is stored in your OS keychain when one is available (macOS `security`, Linux `secret-tool`); otherwise it falls back to `~/.config/me/credentials.yaml` (mode 0600). Set `ME_NO_KEYCHAIN=1` to force the file fallback.
- Non-secret settings (default server and per-server active space) live in `~/.config/me/config.yaml`.
- **API keys are for agents, not humans** — `me login` never creates one. Mint agent keys with [`me apikey create`](me-apikey.md#me-apikey-create).
- Use [`me logout`](me-logout.md) to clear the session; the non-secret config is kept so re-login resumes.

## See also

- [`me space`](me-space.md) -- list and switch the active space.
- [`me whoami`](me-whoami.md) -- show your identity and active space.
