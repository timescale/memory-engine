# me uninstall

Remove Memory Engine harness integrations previously installed by `me install`.
Only deployment records in `~/.config/me/installations.yaml` are removed;
unrecorded harness configuration is left untouched.

## Usage

```bash
me uninstall [claude|opencode|codex...]
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
