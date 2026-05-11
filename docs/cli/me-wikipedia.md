# me wikipedia

Download and import Wikimedia article dumps as Memory Engine memories.

## Commands

- [me wikipedia import](#me-wikipedia-import) -- download and import a Wikipedia XML dump

---

## me wikipedia import

Download and import a Wikipedia dump. Wikimedia article dumps use the **MediaWiki XML export format**, usually distributed as a **bzip2-compressed** `.xml.bz2` archive such as `enwiki-latest-pages-articles-multistream.xml.bz2`.

```
me wikipedia import [source] [options]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `source` | no | Wiki slug (`simplewiki`, `enwiki`), dump URL, or local `.xml` / `.xml.bz2` file. Defaults to `simplewiki`. |

| Option | Description |
|--------|-------------|
| `--wiki <wiki>` | Wiki database name when `source` is omitted or a local file (default: `simplewiki`). |
| `--date <date>` | Dump date for Wikimedia URLs (default: `latest`). |
| `--dump-kind <kind>` | Wikimedia dump kind (default: `pages-articles-multistream`). |
| `--cache-dir <dir>` | Directory for downloaded dump archives. |
| `--force-download` | Redownload even when the cache file exists. |
| `--download-only` | Download the dump archive and exit. |
| `--tree-root <path>` | Tree root for imported memories (default: `wikipedia`). |
| `--namespace <n>` | MediaWiki namespace number to import (default: `0`, articles). |
| `--include-redirects` | Import redirect pages. Redirects are skipped by default. |
| `--content-mode <mode>` | Content to store: `plain` or `wikitext` (default: `plain`). |
| `--max-content-bytes <n>` | Truncate each memory content to this many UTF-8 bytes (`0` disables truncation). |
| `--limit <n>` | Maximum article memories to process after filters. Useful for samples. |
| `--batch-size <n>` | Memories to buffer before each `memory.batchCreate` (default: `500`). |
| `--dry-run` | Parse and estimate without writing memories. |
| `--update-existing` | Update existing deterministic Wikipedia memories instead of skipping them. |
| `-v, --verbose` | Show per-batch progress output. |

### Examples

```bash
# Cheap validation run against Simple English Wikipedia
me wikipedia import --dry-run --limit 1000

# Import Simple English Wikipedia
me wikipedia import simplewiki

# Import full English Wikipedia
me wikipedia import enwiki

# Use an already-downloaded archive
me wikipedia import ~/Downloads/enwiki-latest-pages-articles-multistream.xml.bz2 --wiki enwiki

# Download only
me wikipedia import enwiki --download-only
```

### Memory shape

Each imported article becomes one memory:

- `content`: `# Title` followed by either cleaned plain text or raw wikitext.
- `tree`: `<tree-root>.<primary_category_slug>`, where `primary_category_slug` is the first category in `meta.categories` normalized for ltree, for example `wikipedia.relational_databases`. Articles without categories use `wikipedia.uncategorized`.
- `temporal`: current revision timestamp from the dump.
- `meta`: source metadata including `source_wiki`, `source_page_id`, `source_revision_id`, `source_title`, `source_url`, `categories`, `primary_category`, `primary_category_slug`, `source_format`, `content_format`, and importer version.

IDs are deterministic per `(wiki, page_id)`, so re-running the same import skips already-created articles instead of duplicating them.
