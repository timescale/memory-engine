# me invitation

Manage invitations.

Invitations allow you to add people to an organization before they have an account. The invitee receives a token they can use to accept the invitation after signing up.

## Commands

- [me invitation create](#me-invitation-create) -- invite someone to an organization
- [me invitation list](#me-invitation-list) -- list pending invitations
- [me invitation accept](#me-invitation-accept) -- accept an invitation
- [me invitation revoke](#me-invitation-revoke) -- revoke a pending invitation

---

## me invitation create

Invite someone to an organization.

```
me invitation create <email> <role> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `email` | yes | Email address to invite. |
| `role` | yes | Role: `owner`, `admin`, or `member`. |

| Option | Description |
|--------|-------------|
| `--org <name-or-id>` | Organization name, slug, or ID. |
| `--expires <days>` | Expiration in days (1-30, default: 7). |

Displays the invitation ID, role, expiry, and the invitation token to share with the invitee.

---

## me invitation list

List pending invitations.

```
me invitation list [org] [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `org` | no | Organization name, slug, or ID. |

| Option | Description |
|--------|-------------|
| `--org <name-or-id>` | Organization name, slug, or ID (alternative to positional argument). |

Displays a table of pending invitations with ID, email, role, and expiry.

---

## me invitation accept

Accept an invitation.

```
me invitation accept <token>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `token` | yes | Invitation token received from the inviter. |

You must be logged in to accept an invitation.

---

## me invitation revoke

Revoke a pending invitation.

```
me invitation revoke <id>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Invitation ID. |
