# me agent

Manage agents.

An **agent** is a service account you own — a non-human principal that authenticates with an API key. Agents are **global** (owned by you, names unique per user), independent of any space. Create an agent, add it to the spaces it should work in, then mint it an API key with [`me apikey`](me-apikey.md).

These commands authenticate with your **session** (`me login`). Lifecycle commands (`create`/`list`/`rename`/`delete`) are global; `spaces` lists one of your agent's space memberships; `add`, `remove`, and `groups` operate on the active space.

## Commands

- [me agent list](#me-agent-list) -- list your agents
- [me agent create](#me-agent-create) -- create an agent
- [me agent rename](#me-agent-rename) -- rename an agent
- [me agent delete](#me-agent-delete) -- delete an agent
- [me agent spaces](#me-agent-spaces) -- list the spaces an agent belongs to
- [me agent add](#me-agent-add) -- add an agent to the active space
- [me agent remove](#me-agent-remove) -- remove an agent from the active space
- [me agent groups](#me-agent-groups) -- list an agent's groups in the space

---

## me agent list

List your agents. Alias: `me agent ls`.

```
me agent list
```

---

## me agent create

Create an agent (a global service account you own).

```
me agent create <name>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Agent name (unique among your agents). |

---

## me agent rename

Rename an agent.

```
me agent rename <agent> <new-name>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `agent` | yes | Agent id or name. |
| `new-name` | yes | New name. |

---

## me agent delete

Delete an agent **globally**. Its API keys are deleted with it, and it leaves every space. Alias: `me agent rm`. To take an agent out of a *single* space while keeping it alive elsewhere, use [`me agent remove`](#me-agent-remove) instead.

```
me agent delete <agent>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `agent` | yes | Agent id or name. |

---

## me agent add

Add one of your agents to the active space's roster. It joins with owner over its own home — nested under yours (`/home/<your-id>/<agent-id>`), so you can see what it stores under `~`. Grant it shared access (e.g. on `share`) with [`me access`](me-access.md).

```
me agent add <agent>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `agent` | yes | Agent id or name. |

---

## me agent remove

Remove one of your agents from the active space's roster — the inverse of [`me agent add`](#me-agent-add). Its access grants and group memberships **in this space** are scrubbed; the agent itself, its API keys, and its memberships in other spaces are untouched. Removing your **own** agent is self-service — **no space-admin needed**.

```
me agent remove <agent> [-y]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `agent` | yes | Agent id or name. |

| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip the confirmation prompt. |

To remove someone else's agent (as an admin), use [`me space remove-member`](me-space.md#me-space-remove-member). Note that leaving a space with [`me space leave`](me-space.md#me-space-leave) already removes your agents in that space automatically.

---

## me agent spaces

List the spaces one of your agents belongs to. This uses your logged-in session to verify ownership of the agent; it does not authenticate with the agent's `ME_API_KEY`.

```
me agent spaces <agent>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `agent` | yes | Agent id or name. |

---

## me agent groups

List the groups an agent belongs to in the active space.

```
me agent groups <agent>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `agent` | yes | Agent id or name. |

## See also

- [`me apikey`](me-apikey.md) -- mint, list, and revoke an agent's API keys.
- [`me access`](me-access.md) -- grant the agent access to tree paths.
- [MCP Integration](../mcp-integration.md) -- run an agent against a space over MCP.
