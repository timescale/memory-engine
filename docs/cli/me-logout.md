# me logout

Clear stored credentials.

## Usage

```
me logout
```

## Description

Clears the stored **session token** for the active server — from the OS keychain when one is in use, and from `~/.config/me/credentials.yaml` otherwise. The non-secret config (default server and active space in `~/.config/me/config.yaml`) is kept, so a later `me login` resumes where you left off.

Agent API keys are never persisted by the CLI (they only ever come from `ME_API_KEY`), so there is nothing to clear for agents.

This clears the CLI's local credentials only — it does **not** sign your browser out of the server. Because the browser keeps its own session, a plain `me login` afterward re-authorizes the same account. To sign in as a different account, use [`me login --switch`](me-login.md#switching-accounts), which forces the sign-in page to appear again.

## Global Options

| Option | Description |
|--------|-------------|
| `--server <url>` | Server URL (overrides `ME_SERVER` env and stored default) |
