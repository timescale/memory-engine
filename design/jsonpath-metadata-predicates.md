---
title: Metadata Predicates
tags: [search, metadata, jsonb, jsonpath, gin]
---

# Metadata Predicates

## Metadata filters

Memory Engine stores each memory's metadata as a `jsonb` object and exposes a
structured `meta` search filter. That filter uses PostgreSQL containment:

```sql
memory.meta @> requested_meta
```

Containment is concise, predictable, and supported by the existing GIN index.
It handles exact nested values, object subsets, and array subsets. For example,
an allow-list membership search does not require a new operator:

```ts
client.memory.search({
  meta: { allowList: ["tom"] },
});
```

PostgreSQL evaluates that as:

```sql
meta @> '{"allowList":["tom"]}'::jsonb
```

This matches `{"allowList":["tom","alice"]}`. PostgreSQL's containment
rules preserve the nested array shape, ignore array order, and allow the right
array to be a subset of the left array. A scalar query such as
`{"allowList":"tom"}` does not match because it has the wrong structure.

Containment cannot express computations or general Boolean conditions. Useful
metadata searches outside its scope include:

```text
$.priority >= 3
$.status == "active" || $.status == "pending"
!exists($.archivedAt)
$.name like_regex "^prod-" flag "i"
$.allowList.size() > 10
$.used / $.limit >= 0.8
$.actual > $.expected
exists($.grants[*] ? (@.user == "tom" && @.level >= 2))
```

PostgreSQL 18 provides two related JSONPath contracts:

- `@?` and `jsonb_path_exists` test whether a SQL-standard path returns any
  item.
- `@@` and `jsonb_path_match` evaluate a PostgreSQL predicate check expression
  and return its Boolean result.

These contracts are not interchangeable. A predicate passed to `@?` still
returns an item when its value is `false`, so an existence check can incorrectly
report a match. PostgreSQL's documentation says predicate check expressions are
required for `@@` and should not be used with `@?`.

SQL/JSON path syntax is less familiar than ordinary SQL, JavaScript-oriented
JSONPath dialects, or PostgreSQL's basic JSON operators. Language models can
construct common PostgreSQL predicates when given canonical examples, but are
otherwise prone to mixing dialects, using `=` instead of `==`, confusing `$`
with `@`, or confusing `@?` with `@@`. The public contract must make the
predicate semantics explicit rather than relying on callers to infer them.

The `meta` column has a plain GIN index. PostgreSQL therefore uses the default
`jsonb_ops` operator class. PostgreSQL 18 documents `@>`, `@?`, and `@@` as
indexable operators for this class. For JSONPath operators, GIN extracts clauses
of the form `accessor_chain == constant`; an accessor chain may include object
keys, `[*]`, and fixed array indexes. Equality predicates can therefore narrow
the candidate set with the existing index, while inequalities, arithmetic,
regular expressions, cardinality checks, and negation may require broad scans.

Relevant PostgreSQL 18 documentation:

- [`jsonb` containment and existence](https://www.postgresql.org/docs/18/datatype-json.html#JSON-CONTAINMENT)
- [`jsonb` indexing](https://www.postgresql.org/docs/18/datatype-json.html#JSON-INDEXING)
- [JSON functions and operators](https://www.postgresql.org/docs/18/functions-json.html#FUNCTIONS-JSON)
- [Boolean predicate check expressions](https://www.postgresql.org/docs/18/functions-json.html#FUNCTIONS-SQLJSON-CHECK-EXPRESSIONS)
- [GIN built-in operator classes](https://www.postgresql.org/docs/18/gin.html#GIN-BUILTIN-OPCLASSES)

## `metaPredicate` interface

`metaPredicate` is an optional search filter containing a PostgreSQL `jsonpath`
predicate check expression. Evaluate it with the `@@` operator:

```ts
client.memory.search({
  metaPredicate: '$.allowList[*] == "tom"',
});
```

```sql
memory.meta @@ requested_meta_predicate
```

The name is `metaPredicate`, not `metaQuery`. It describes the required Boolean
contract and follows PostgreSQL's term "predicate check expression". The broader
name `metaQuery` would not distinguish `@@` predicate semantics from `@?`
path-existence semantics.

The existing `meta` filter remains the preferred interface for structural
containment. `metaPredicate` is an additive advanced filter, not a replacement.
When both are supplied, they are combined with `AND`, like the other search
filters:

```ts
client.memory.search({
  meta: { workspace: "acme" },
  metaPredicate: '$.priority >= 3 && !exists($.archivedAt)',
});
```

The predicate is passed as data and cast to `jsonpath`; it is never interpolated
as executable SQL. Invalid JSONPath syntax is a validation error. PostgreSQL's
`@@` behavior suppresses missing-field, missing-element, unexpected-type,
numeric, and datetime evaluation errors, which is appropriate for heterogeneous
metadata. Callers may prefix a path with `strict` when they need exact structural
matching instead of lax-mode array wrapping and unwrapping; the operator still
suppresses the documented evaluation errors.

The same filter is available on public surfaces that provide the complete memory
search contract, including the TypeScript client, CLI, MCP search and export
tools, and advanced web search. Their descriptions and documentation include
PostgreSQL-specific examples for equality, numeric comparison, Boolean
composition, nested `exists`, and regular expressions.

Apply `metaPredicate` before ranking in semantic, fulltext, and hybrid search,
as with the existing metadata containment filter. In hybrid search, both arms
receive the predicate before candidate ranks and Reciprocal Rank Fusion are
computed.

Keep the existing `jsonb_ops` GIN index. Use the `@@` operator directly rather
than `jsonb_path_match`, because the existing GIN operator class provides an
index strategy for `@@`, not for the function call. Do not promise that every
valid predicate is index-backed: documentation must distinguish extractable
equality predicates from predicates that may scan.

## Behavior and constraints

- Callers can express metadata comparisons, ranges, OR and negation, missing-key
  checks, regexes, array cardinality, arithmetic, cross-field comparisons, and
  nested existential conditions.
- Simple equality and allow-list membership remain easier to express with
  structured `meta` containment and should continue to use it.
- The name and examples guide language models toward PostgreSQL predicate syntax
  and away from the `@?` false-item trap, but raw JSONPath remains an advanced
  interface that models can construct incorrectly.
- Equality clauses such as `$.allowList[*] == "tom"` can use the current GIN
  index. More expressive predicates may be substantially more expensive, even
  though they use the same public field.
- Missing or differently typed metadata generally produces a non-match rather
  than failing the whole search because `@@` suppresses common structural and
  evaluation errors.
- The public API uses PostgreSQL's SQL/JSON path dialect rather than a custom
  expression language.
- Database search-function signatures retain `metaPredicate` as a trailing,
  defaulted argument so existing positional callers remain valid.
- Client/server compatibility requires a server that understands the filter; a
  request must never silently drop it and return broader results.
