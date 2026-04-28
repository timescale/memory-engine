---
tree: __TREE_BASE__.imports.md
meta:
  itest: true
  run_id: __RUN_ID__
  source: markdown_fixture
---
# Markdown Fixture

This memory is imported from a Markdown file with YAML frontmatter as part
of the `me` CLI integration test. It exercises the `parseMarkdown` path of
`me memory import`.

The content includes a few formatting features so that the parser doesn't
trip on common cases:

- Lists
- **Bold** and _italic_
- `inline code`
- Multi-paragraph content
