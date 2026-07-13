# me invite

View and act on invitations addressed to you.

`me invite` is the invitee-side command group. It is distinct from
[`me space invite`](me-space.md#me-space-invite), which space admins use to send
invitations.

## Commands

- [me invite list](#me-invite-list) -- list invitations addressed to your email
- [me invite accept](#me-invite-accept) -- accept an invitation and join the space
- [me invite decline](#me-invite-decline) -- decline a pending invitation
- [me invite redeem](#me-invite-redeem) -- redeem an invite link or raw token

---

## me invite list

List pending invitations addressed to your verified email. Alias: `me invite ls`.

```bash
me invite list
```

If no invitations are pending, the command prints `No pending invitations.`

---

## me invite accept

Accept one email invitation and join the space.

```bash
me invite accept <id>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Invitation id from `me invite list`. |

In an interactive terminal, the CLI asks whether to switch your active space to
the joined space. In non-interactive output, it prints the joined space and a
`me space use <slug>` hint.

---

## me invite decline

Decline one pending email invitation.

```bash
me invite decline <id>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Invitation id from `me invite list`. |

---

## me invite redeem

Redeem a magic invite link. Pass either the full URL or the raw token.

```bash
me invite redeem <link>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `link` | yes | Invite URL or raw invite token. |

Open shareable links can be redeemed by any signed-in user, subject to the link's
expiry and usage limit. Email-constrained links require your verified email to
match the invite.

## Global Options

| Option | Description |
|--------|-------------|
| `--server <url>` | Server URL (overrides `ME_SERVER` env and stored default). |
| `--json` | Output as JSON. |
| `--yaml` | Output as YAML. |

## See also

- [`me space invite`](me-space.md#me-space-invite) -- send and manage invitations as a space admin.
- [`me space use`](me-space.md#me-space-use) -- switch your active space after joining.
- [Joining a Space](../joining-a-space.md) -- walkthrough for invited teammates.
