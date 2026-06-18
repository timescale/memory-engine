-------------------------------------------------------------------------------
-- memory.name
--
-- An optional, mutable, human-chosen leaf name, unique within a tree path. The
-- UUID stays the immutable identity (embeddings, audit, links survive
-- rename/move); `name` is additive addressing (`/share/auth/jwt-rotation`) and
-- the idempotency key for `(tree, name)` upserts. Filename-like and allowed to
-- contain dots — it is never an ltree label, so a dotted name cannot collide
-- with the tree separator.
-------------------------------------------------------------------------------
alter table {{schema}}.memory add column name text;

-- Unique within the exact tree path. Partial (where name is not null) so any
-- number of unnamed memories coexist under one tree, and two different trees
-- may reuse a name.
create unique index memory_tree_name_uidx on {{schema}}.memory (tree, name)
where name is not null;

-- Defensive format check (the application validates the same shape): a
-- filename-like slug that must start alphanumeric, so `.`/`..`/hidden names are
-- rejected, no slashes or spaces, <= 128 chars.
alter table {{schema}}.memory add constraint memory_name_format check
(
  name is null
  or (name operator(pg_catalog.~) '^[A-Za-z0-9][A-Za-z0-9._-]*$' and length(name) <= 128)
);
