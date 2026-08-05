# me uninstall

Remove Memory Engine harness integrations previously installed by `me install`.
Memory Engine uses its installation record to remove the artifacts it owns;
unrecorded or modified provider configuration is left untouched.

## Usage

```bash
me uninstall [claude|opencode|codex...]
me uninstall --purge [claude|opencode|codex...]
```

With no harness names, `me uninstall` removes every recorded integration.
Supplying names removes only those recorded harnesses. An absent record is a
successful no-op.

## Examples

```bash
me uninstall
```

Remove only the Codex integration:

```bash
me uninstall codex
```

The equivalent single-harness commands are `me claude uninstall`,
`me opencode uninstall`, and `me codex uninstall`.

Uninstalling a harness does not remove your machine-local `me init` policy
unless you pass `--purge`. That option also removes the selected harness from
your saved activation profiles. See [Harness
Integrations](../harness-integrations.md) for the distinction between
installation and activation.
