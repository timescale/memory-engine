# me completions

Set up shell completions.

## Usage

```
me completions [shell]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `shell` | no | Shell type: `zsh`, `bash`, `fish`, or `powershell`. |

If no shell is specified, lists the available shells.

## Setup

Add one of the following to your shell config:

### Bash

```bash
source <(me complete bash)
```

### Zsh

```bash
source <(me complete zsh)
```

### Fish

```fish
me complete fish | source
```

### PowerShell

```powershell
me complete powershell | Out-String | Invoke-Expression
```
