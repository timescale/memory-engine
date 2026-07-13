# me login

Authenticate with Memory Engine via OAuth.

## Usage

```
me login [space]
me login --switch
```

| Argument | Required | Description |
|----------|----------|-------------|
| `space` | no | Space slug or name to make active after login. |

## Description

Starts an OAuth 2.1 authorization-code flow with PKCE over a loopback redirect. The CLI opens your browser to the sign-in page, you choose a provider (Google or GitHub), and once you approve it stores your **session token**. Sessions are rolling: valid for 7 days and refreshed as you keep using the CLI.

If you pass a `space` argument, it becomes the active space. Otherwise, if you belong to exactly one space it's selected automatically; if you belong to several, run `me space use` to pick one. The active space is carried as the `X-Me-Space` header on subsequent commands.

Login also runs the same version compatibility check as `me version` before opening the browser, so an out-of-date CLI gets a clean upgrade prompt instead of failing mid-flow.

## Switching accounts

Your browser keeps its own session with the server, independent of the CLI. When that session is still valid, the sign-in page is skipped and the CLI is authorized for the account you're already signed in as — so a plain `me logout` followed by `me login` puts you right back in the same account (logout only clears the CLI's local credentials, not the browser session).

To sign in as a different account (for example, switching from a personal GitHub identity to a work Google one), run:

```
me login --switch
```

`--switch` forces the server to re-show its sign-in page even when the browser already has a session, so you can pick a different provider or account.

## Options

| Option | Description |
|--------|-------------|
| `--switch` | Force the browser to re-show the sign-in page, even if it already has a session (use to switch accounts). |

## Global Options

| Option | Description |
|--------|-------------|
| `--server <url>` | Server URL (overrides `ME_SERVER` env and stored default) |

## Notes

- The session token is stored in your OS keychain when one is available (macOS `security`, Linux `secret-tool`); otherwise it falls back to `~/.config/me/credentials.yaml` (mode 0600). Set `ME_NO_KEYCHAIN=1` to force the file fallback.
- Non-secret settings (default server and per-server active space) live in `~/.config/me/config.yaml`.
- **Humans authenticate with a session, not an API key** — `me login` never creates a key. For headless/CLI use where a session isn't available you can mint a **personal access token** (acts as you) with [`me apikey create`](me-apikey.md#me-apikey-create); agent keys come from `me apikey create --agent <agent>`, and team-owned service-account keys come from `me apikey create --service <service>`.
- Use [`me logout`](me-logout.md) to clear the session; the non-secret config is kept so re-login resumes.

## See also

- [`me space`](me-space.md) -- list and switch the active space.
- [`me whoami`](me-whoami.md) -- show your identity and active space.
