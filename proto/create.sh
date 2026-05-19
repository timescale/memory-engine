#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(dirname -- "$script_dir")"

: "${DATABASE_URL:?DATABASE_URL is required}"

"$repo_dir/bun" "$script_dir/create.ts" | psql -d "$DATABASE_URL" \
  --single-transaction \
  -v ON_ERROR_STOP=1 \
  -f -
