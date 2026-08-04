# me ci

Generate a starter GitHub Actions workflow that imports a repository's git history and Markdown docs into one Memory Engine space.

## Commands

- [me ci install](#me-ci-install) -- generate the GitHub Actions workflow and optionally set its credential

---

## me ci install

```
me [--server <url>] ci install [--server <url>] [options]
```

Run this from a git repository with a GitHub `origin` remote. It writes `.github/workflows/me-import.yml`, which imports git history and docs on pushes to the default branch. The generated workflow is yours to edit after creation.

The command refuses to replace an existing workflow. Pass `--force` to replace the entire file.

| Option | Description |
| --- | --- |
| `--server <url>` | Selects the Memory Engine server. It may appear before `ci` or after `install`; the `install` value wins if both are supplied. The workflow includes `ME_SERVER` when it is not the default hosted server. |
| `--space <slug>` | Destination space. Required outside an interactive terminal. |
| `--tree <path>` | Shared destination tree. Default: `/share/projects/<repo-name>`; home (`~`) trees are invalid for service accounts. |
| `--secret-name <name>` | GitHub secret name. Default: `ME_API_KEY`. |
| `--service-account <name>` | Service account name. Default: `<repo-name>-import`. |
| `--create-service-account` | Create the service account, grant it write access at the selected tree, mint a key, and pipe it directly to `gh secret set`. Intended for scripted use. |
| `--workflow-only` | Write the workflow without touching credentials. Intended for scripted use. |
| `--force` | Replace an existing `.github/workflows/me-import.yml`. |

In a terminal, choose a space and then either provide an existing service-account key or create a service account. Existing keys are entered without echo and are piped directly to `gh secret set`; they are never written into the workflow or saved by `me`.

Creating credentials requires a space admin and an authenticated `gh` CLI with permission to write repository secrets. A newly minted key is created only for immediate placement in the GitHub secret; if placement fails, `me` revokes it. Non-admins can still place an existing key, or receive commands and space-admin contacts for completing setup manually.

The workflow runs these commands explicitly:

```sh
me import git --tree /share/projects/<repo-name>
me import docs . --git-aware --prune --tree /share/projects/<repo-name>
```
