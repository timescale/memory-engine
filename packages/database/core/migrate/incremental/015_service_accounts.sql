-------------------------------------------------------------------------------
-- service accounts: principal shape and durable constraints.
--
-- This migration makes service accounts representable in core.principal and
-- installs the schema-level constraints/indexes they need. The companion
-- idempotent functions in this migration set add lifecycle operations,
-- bound-admin-group enforcement, and effective-access behavior.
-------------------------------------------------------------------------------

-- Add the service-account admin-group pointer. The FK targets principal(group_id)
-- so a non-null admin_id can only point at a group principal.
alter table {{schema}}.principal
  add column admin_id uuid references {{schema}}.principal (group_id)
;

-- `member_id` is the credential/group-membership identity for real members.
-- Service accounts are credential-bearing members, unlike groups.
alter table {{schema}}.principal
  alter column member_id set expression as
    (case when kind in ('u', 'a', 's') then id else null end)
;

-- Replace the original kind check (`g|u|a`) with `g|u|a|s`. The original check
-- is a column-level CHECK, so its name (`principal_kind_check`) is Postgres-
-- generated rather than one we chose — look it up by structure (the sole check
-- constraint on principal whose columns are exactly {kind}) and drop that,
-- rather than trusting the generated name.
do $$
declare
  _conname text;
  _kind smallint;
begin
  select attnum into _kind
  from pg_attribute
  where attrelid = '{{schema}}.principal'::regclass and attname = 'kind';

  select c.conname into _conname
  from pg_constraint c
  where c.conrelid = '{{schema}}.principal'::regclass
  and c.contype = 'c'
  and c.conkey @> array[_kind] and c.conkey <@ array[_kind]; -- exactly {kind}

  if _conname is not null then
    execute format('alter table {{schema}}.principal drop constraint %I', _conname);
  end if;
end $$;

alter table {{schema}}.principal
  add constraint principal_kind_check check (kind in ('g', 'u', 'a', 's'))
;

-- Groups and service accounts are space-scoped. Users and agents are global.
-- The original space-scoping invariant is one of two *unnamed* table-level
-- CHECKs in 002_principal (auto-named `principal_check` / `principal_check1` in
-- definition order), so dropping it by the guessed name is fragile. Identify it
-- by structure instead: the check whose columns are exactly {kind, space_id}
-- (the sibling owner check is {kind, owner_id}), and leave that owner check
-- untouched (it stays valid for `s`, which is not `a`).
do $$
declare
  _conname text;
  _kind smallint;
  _space smallint;
begin
  select attnum into _kind
  from pg_attribute
  where attrelid = '{{schema}}.principal'::regclass and attname = 'kind';
  select attnum into _space
  from pg_attribute
  where attrelid = '{{schema}}.principal'::regclass and attname = 'space_id';

  select c.conname into _conname
  from pg_constraint c
  where c.conrelid = '{{schema}}.principal'::regclass
  and c.contype = 'c'
  and c.conkey @> array[_kind, _space]
  and c.conkey <@ array[_kind, _space]; -- exactly {kind, space_id}

  if _conname is not null then
    execute format('alter table {{schema}}.principal drop constraint %I', _conname);
  end if;
end $$;

alter table {{schema}}.principal
  add constraint principal_space_scope_check check
  (
    (kind in ('g', 's') and space_id is not null)
    or
    (kind not in ('g', 's') and space_id is null)
  )
;

-- Only service accounts have a bound admin group.
alter table {{schema}}.principal
  add constraint principal_service_account_admin_check check
  (
    (kind = 's' and admin_id is not null)
    or
    (kind != 's' and admin_id is null)
  )
;

-- Agent, group, and service-account names are CLI/API handles, not emails or
-- arbitrary display strings.
alter table {{schema}}.principal
  drop constraint principal_agent_group_name_check
, add constraint principal_agent_group_name_check check
  (
    kind not in ('a', 'g', 's')
    or name::text ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
  )
;

-- Groups and service accounts share the same per-space handle namespace. The
-- older 002_principal migration created a group-only unnamed index; replace it
-- here rather than editing historical migrations.
do $$
declare
  _index_name text;
begin
  select idx.relname into _index_name
  from pg_index i
  join pg_class idx on idx.oid = i.indexrelid
  where i.indrelid = '{{schema}}.principal'::regclass
  and i.indisunique
  and i.indpred is not null
  and i.indkey::text =
    (
      select format('%s %s', space_id_att.attnum, name_att.attnum)
      from pg_attribute space_id_att
      cross join pg_attribute name_att
      where space_id_att.attrelid = '{{schema}}.principal'::regclass
      and space_id_att.attname = 'space_id'
      and name_att.attrelid = '{{schema}}.principal'::regclass
      and name_att.attname = 'name'
    )
  and pg_get_expr(i.indpred, i.indrelid) in
    ( 'group_id IS NOT NULL'
    , '(group_id IS NOT NULL)'
    );

  if _index_name is not null then
    execute format('drop index {{schema}}.%I', _index_name);
  end if;
end $$;

create unique index principal_space_handle_name
  on {{schema}}.principal (space_id, name) where kind in ('g', 's');

-- Service-account admin groups are dedicated one-to-one bindings.
create unique index principal_service_account_admin_id
  on {{schema}}.principal (admin_id) where kind = 's';

comment on column {{schema}}.principal.admin_id is
  'For service accounts (kind=s), points at the bound admin group via principal(group_id).';
