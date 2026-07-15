# Joining a Space

Someone invited you to a shared Memory Engine **space** — a common pool of
knowledge your team searches and adds to. This guide gets you from an invite to
your first search and your first shared memory, and covers the conventions that
keep a shared space useful for everyone.

New to the core ideas (memories, trees, search)? Skim [Core Concepts](concepts.md)
first. To set Memory Engine up in a specific repo, see [Projects](projects.md)
and [Project config](project-config.md).

## 1. Install and log in

If you don't have the CLI yet:

```bash
curl -fsSL https://install.memory.build | sh
```

Then sign in:

```bash
me login
```

This opens your browser to sign in with GitHub or Google. **Use the account that
matches the email you were invited with** — your invite is tied to that identity.
If your browser signs in with the wrong account, run `me login --switch` and
choose the invited account. If you're on SSH, a remote VM, or another
browserless environment, use `me login --device` instead. See
[`me login`](cli/me-login.md) for details.

**Prefer not to use the terminal?** You don't have to. Open
[**api.memory.build**](https://api.memory.build/) and sign in with the same
GitHub/Google account — you can browse, search, and add memories entirely in the
browser. The rest of this guide shows the CLI, but each step has an equivalent in
the web UI. See [Browse in the web UI](#6-browse-in-the-web-ui).

## 2. Accept the invite

Email invitations are pending until you accept them. List your pending invites,
then accept the one for this space:

```bash
me invite list
me invite accept <invitation-id>
```

If you received an invite link instead, redeem it directly:

```bash
me invite redeem <invite-url>
```

In an interactive terminal, `me invite accept` / `me invite redeem` asks whether
to switch your active space to the space you just joined. If you skip that prompt
or are running non-interactively, switch manually:

```bash
me space list
me space use <slug-or-name>
```

Confirm you're in the right place:

```bash
me whoami
```

`me whoami` shows your identity and your **active space** — the space every
memory command reads from and writes to. If you only belong to one space, it's
selected automatically after login.

See [`me invite`](cli/me-invite.md) for the full invitee-side command reference.

## 3. What you can see: `share` vs `~`

Every space has two conventional roots:

- **`/share`** — shared knowledge. This is what the space is *for*: memories the
  whole team should see live here.
- **`~`** — your own private home. Memories under `~` are private by default (a
  scratchpad, personal notes), unless you explicitly grant someone else access.
  For example, `~/notes` is your personal `notes` folder, separate from
  `/share/notes`.

You'll see shared memories in `/share/...` and your own under `~/...`. What
exactly you can read and write is controlled by grants — see
[Access Control](access-control.md). If a search turns up fewer results than you
expect, you may simply not have access to that part of the tree yet; ask a space
admin.

## 4. Search before you add

The first thing to do in a populated space is **look around** — both to find what
you need and to avoid duplicating knowledge that's already there.

```bash
# Hybrid search (matches meaning + keywords)
me search "how do we handle auth token rotation"

# See the shape of what's stored
me tree
```

More search modes and filters are in [Core Concepts → Search](concepts.md#search).

## 5. Store your first memory

Add a shared memory the rest of the space can find. A `--tree` is required, so
you choose deliberately whether it's shared or private:

```bash
# Shared with the space
me create "We rotate JWT signing keys every 90 days via the ops runbook." \
  --tree /share/auth \
  --name jwt-rotation

# Private to you
me create "Reminder: ask about the staging DB migration." --tree ~/notes
```

The optional `--name` gives the memory a filename-like slug so you can address it
by path later — `me get /share/auth/jwt-rotation`.

## 6. Browse in the web UI

For a visual experience — a tree explorer, search, and a Markdown viewer/editor —
use the web UI:

- **Hosted (no install):** [**api.memory.build**](https://api.memory.build/), signed
  in with your GitHub/Google account. Pick this space from the switcher and you're in.
- **Local:** run `me serve` to open the same UI against your CLI session on
  `http://127.0.0.1:3000`. See [`me serve`](cli/me-serve.md).

## Conventions for a shared space

A shared space stays valuable when everyone follows a few habits:

- **Search before you create.** Duplicates make search noisier for everyone.
  Check whether the fact already exists first.
- **One idea per memory.** Three decisions are three memories, each findable on
  its own.
- **Be specific and self-contained.** "Auth uses bcrypt with cost 12" beats "we
  use bcrypt." A memory should make sense to a teammate who wasn't in the room.
- **Shared goes under `/share`, personal under `~`.** Don't put team knowledge in
  your private home where no one else can find it.
- **Agree on a tree layout.** A little structure goes a long way — e.g.
  `/share/design/<area>`, `/share/runbooks/<system>`, `/share/decisions`. Keep
  paths 2–4 levels deep.
- **Put repository memory under a project tree.** Use `/share/projects/<repo>`
  when the whole team should write, or `/share/<group>/<repo>` when a subgroup
  owns writes. See [Projects](projects.md).
- **Use metadata for attributes.** Tag things like `{"type": "decision"}` or
  `{"status": "active"}` so they can be filtered later. See
  [Metadata](concepts.md#metadata).

## What's next

- [Core Concepts](concepts.md) — the memory model, tree paths, and search in depth
- [Access Control](access-control.md) — how grants decide what you can see and do
- [MCP Integration](mcp-integration.md) — let your AI coding tools use the space
- [Project config](project-config.md) — point a repo at this space for your whole team
