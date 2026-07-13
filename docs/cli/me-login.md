# me login

Authenticate with Memory Engine via OAuth.

## Usage

```
me login [space]
me login --switch
me login --device [space]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `space` | no | Space slug or name to make active after login. |

## Description

Authenticates with Memory Engine and stores your credentials. There are two flows:

- **Default (browser):** an OAuth 2.1 authorization-code flow with PKCE over a `127.0.0.1` loopback redirect (RFC 8252). The CLI opens your browser to the sign-in page, you choose a provider (Google or GitHub), and the browser redirects back to the CLI, which exchanges the code for an access + refresh token pair. This needs a browser **on the same machine** as the CLI. (See [Switching accounts](#switching-accounts) for `--switch`.)

- **Device (`--device`):** the OAuth 2.0 Device Authorization Grant (RFC 8628), for **headless** environments — an agent harness in a sandbox, a remote SSH session, a container — where the loopback flow can't reach a local browser. The CLI prints a short URL and a code; you open the URL on **any** device, sign in, and enter the code, and the CLI polls until you approve. This yields a rolling **session token** (valid for 7 days, refreshed as you keep using the CLI) rather than an access/refresh pair; when it lapses you simply run `me login --device` again.

If you pass a `space` argument, it becomes the active space. Otherwise, if you belong to exactly one space it's selected automatically; if you belong to several, run `me space use` to pick one. The active space is carried as the `X-Me-Space` header on subsequent commands.

Login also runs the same version compatibility check as `me version` before starting, so an out-of-date CLI gets a clean upgrade prompt instead of failing mid-flow.

## Options

| Option | Description |
|--------|-------------|
| `--switch` | Force the browser to re-show the sign-in page, even if it already has a session (use to switch accounts). |
| `--device` | Log in without a local browser (device authorization grant). Prints a URL + code to approve on any device. |
| `--no-browser` | Don't open a browser automatically — just print the URL (and the code, with `--device`) to open yourself. Applies to both flows (useful over SSH). |

## Switching accounts

Your browser keeps its own session with the server, independent of the CLI. When that session is still valid, the sign-in page is skipped and the CLI is authorized for the account you're already signed in as — so a plain `me logout` followed by `me login` puts you right back in the same account (logout only clears the CLI's local credentials, not the browser session).

To sign in as a different account (for example, switching from a personal GitHub identity to a work Google one), run:

```
me login --switch
```

`--switch` forces the server to re-show its sign-in page even when the browser already has a session, so you can pick a different provider or account.

`--switch` only applies to the browser flow — it's **not** supported with `--device` (the device flow authorizes whichever account is signed in to your browser, so `me login --device --switch` is rejected). To switch accounts on a headless login, sign out in the browser you'll approve from first.

## Global Options

| Option | Description |
|--------|-------------|
| `--server <url>` | Server URL (overrides `ME_SERVER` env and stored default) |

## Notes

- Your login credentials (the token set from either flow) are stored in your OS keychain when one is available (macOS `security`, Linux `secret-tool`); otherwise they fall back to `~/.config/me/credentials.yaml` (mode 0600). Set `ME_NO_KEYCHAIN=1` to force the file fallback.
- `--device` is the recommended way to log in from a sandboxed agent harness or any host with no browser. The approval page lives at `<server>/device`; the CLI shows a `<server>/device?user_code=…` link that pre-fills the code.
- Non-secret settings (default server and per-server active space) live in `~/.config/me/config.yaml`.
- **Humans authenticate with a session, not an API key** — `me login` never creates a key. For headless/CLI use where a session isn't available you can mint a **personal access token** (acts as you) with [`me apikey create`](me-apikey.md#me-apikey-create); agent keys come from `me apikey create --agent <agent>`, and team-owned service-account keys come from `me apikey create --service <service>`.
- Use [`me logout`](me-logout.md) to clear the session; the non-secret config is kept so re-login resumes.

## See also

- [`me space`](me-space.md) -- list and switch the active space.
- [`me whoami`](me-whoami.md) -- show your identity and active space.
