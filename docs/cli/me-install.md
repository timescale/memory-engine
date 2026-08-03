# me install

Install Memory Engine's dormant integration plumbing for supported coding
harnesses. Installation does not enable MCP tools, capture, or any other
Memory Engine behavior.

## Usage

```bash
me install [claude|opencode|codex|gemini...]
```

With no harness names, `me install` detects supported harness binaries on
`PATH` and installs each detected integration. Supplying names installs only
those harnesses.

Each integration registers the stable `me mcp` command without credentials,
server, space, or project settings. Runtime behavior is configured separately.

## Examples

```bash
me install
```

Install only OpenCode and Codex:

```bash
me install opencode codex
```

The equivalent single-harness commands are `me claude install`,
`me opencode install`, `me codex install`, and `me gemini install`.
