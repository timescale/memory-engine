# Access Control

Memory Engine uses tree-grant RBAC (Role-Based Access Control) enforced at the database level with PostgreSQL Row-Level Security.

## Users

A user is a principal within an engine. Users can:

- Own memories
- Receive grants to access tree paths
- Authenticate via API keys
- Belong to roles

Create a user:

```bash
me user create alice
```

Users with the `--superuser` flag bypass all access checks. Users with `--createrole` can create other users and roles.

Users created with `--no-login` are roles -- they cannot authenticate directly but can be granted access that members inherit.

## Roles

Roles group users together. When a grant is given to a role, all members of that role inherit the access.

```bash
# Create a role
me role create engineering

# Add members
me role add-member engineering alice
me role add-member engineering bob

# Grant access to the role (all members inherit it)
me grant create engineering work.projects read write create
```

Roles are implemented as users with `canLogin: false`. This means grants work the same way for users and roles.

## Grants

Grants control what actions a user (or role) can perform on a tree path. A grant specifies:

- **user** -- who receives the access
- **path** -- which tree path (and all descendants)
- **actions** -- what they can do: `read`, `write`, `create`, `delete`, `admin`

```bash
# Grant read/write access to a tree branch
me grant create alice work.projects read write

# Grant full access
me grant create bob work read write create delete admin

# Check access
me grant check alice work.projects.api read
```

Grants are hierarchical -- a grant on `work` covers `work.projects`, `work.projects.api`, etc.

### Actions

| Action | Description |
|--------|-------------|
| `read` | Search and retrieve memories |
| `write` | Update existing memories |
| `create` | Create new memories |
| `delete` | Delete memories |
| `admin` | Manage grants and ownership |

### Grant option

When creating a grant with `--with-grant-option`, the grantee can re-grant that same access to others:

```bash
me grant create alice work.projects read write --with-grant-option
```

Alice can now grant `read` and `write` on `work.projects` to other users.

## Ownership

Each tree path can have at most one owner. The owner has implicit admin access to that path and all descendants.

```bash
# Set owner
me owner set work.projects.api alice

# Check owner
me owner get work.projects.api

# List all ownership records
me owner list
```

Ownership is distinct from grants:

- **Grants** are explicit, cumulative, and can be given to multiple users.
- **Ownership** is unique per path and provides automatic admin access.

## How it works

Access control is enforced by PostgreSQL Row-Level Security (RLS) policies on the `me.memory` table. When a user authenticates with an API key, the database session is configured with their identity. Every query automatically checks whether the user has the required grant for the memory's tree path.

This means access control cannot be bypassed by application bugs -- it's enforced by the database itself.

## Example: team setup

```bash
# Create users
me user create alice
me user create bob
me user create carol

# Create a shared role
me role create team
me role add-member team alice
me role add-member team bob
me role add-member team carol

# Grant the team read access to everything
me grant create team "" read

# Grant write access to specific branches
me grant create alice work.frontend read write create
me grant create bob work.backend read write create
me grant create carol work.infra read write create delete admin
```
