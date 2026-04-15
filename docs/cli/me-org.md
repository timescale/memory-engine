# me org

Manage organizations.

Organizations group engines and members. Each engine belongs to exactly one organization.

## Commands

- [me org list](#me-org-list) -- list your organizations
- [me org create](#me-org-create) -- create an organization
- [me org delete](#me-org-delete) -- delete an organization
- [me org member list](#me-org-member-list) -- list organization members
- [me org member add](#me-org-member-add) -- add a member
- [me org member remove](#me-org-member-remove) -- remove a member

---

## me org list

List your organizations.

```
me org list
```

Displays a table of organizations you belong to, showing ID, name, and slug.

---

## me org create

Create an organization.

```
me org create <name>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Organization name. |

---

## me org delete

Delete an organization.

```
me org delete <name-or-id> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `name-or-id` | yes | Organization name, slug, or ID. |

| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip the confirmation prompt. |

This operation is irreversible.

---

## me org member list

List organization members.

```
me org member list [org] [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `org` | no | Organization name, slug, or ID. |

| Option | Description |
|--------|-------------|
| `--org <name-or-id>` | Organization name, slug, or ID (alternative to positional argument). |

Displays a table of members with name, email, role, and join date.

---

## me org member add

Add a member to an organization.

```
me org member add <email-or-id> <role> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `email-or-id` | yes | Email address or identity ID of the person to add. |
| `role` | yes | Role: `owner`, `admin`, or `member`. |

| Option | Description |
|--------|-------------|
| `--org <name-or-id>` | Organization name, slug, or ID. |

---

## me org member remove

Remove a member from an organization.

```
me org member remove <name-email-or-id> [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `name-email-or-id` | yes | Member name, email, or identity ID. |

| Option | Description |
|--------|-------------|
| `--org <name-or-id>` | Organization name, slug, or ID. |
| `-y, --yes` | Skip the confirmation prompt. |
