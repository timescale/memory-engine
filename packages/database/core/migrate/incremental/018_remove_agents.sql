-------------------------------------------------------------------------------
-- Remove retired agent principals in one atomic schema upgrade.
--
-- Incrementals run before idempotents, so drop every function that still
-- depends on agent columns before removing those columns. The living idempotents
-- recreate the surviving functions with their agent-free shapes.
-------------------------------------------------------------------------------
drop function if exists {{schema}}.build_tree_access(uuid, uuid, uuid);
drop function if exists {{schema}}.agent_tree_access(uuid, uuid);
drop function if exists {{schema}}.create_agent(uuid, text, uuid);
drop function if exists {{schema}}.list_agents(uuid);
drop function if exists {{schema}}.add_principal_to_space(uuid, uuid, bool);
drop function if exists {{schema}}.remove_principal_from_space(uuid, uuid);
drop function if exists {{schema}}.get_principal(uuid);
drop function if exists {{schema}}.get_user_by_name(text);
drop function if exists {{schema}}.list_space_principals(uuid, text);
drop function if exists {{schema}}.validate_api_key(text, text);

-- Deleting the principals cascades their memberships, group memberships,
-- grants, API keys, and scoped-key declarations. Space memory tables are not
-- part of core and deliberately remain untouched.
delete from {{schema}}.principal where kind = 'a';

-- The original owner invariant references owner_id, so remove it by the
-- columns it covers rather than relying on its generated constraint name.
do $$
declare
  _conname text;
  _kind smallint;
  _owner smallint;
begin
  select attnum into _kind
  from pg_attribute
  where attrelid = '{{schema}}.principal'::regclass and attname = 'kind';
  select attnum into _owner
  from pg_attribute
  where attrelid = '{{schema}}.principal'::regclass and attname = 'owner_id';

  select c.conname into _conname
  from pg_constraint c
  where c.conrelid = '{{schema}}.principal'::regclass
  and c.contype = 'c'
  and c.conkey @> array[_kind, _owner]
  and c.conkey <@ array[_kind, _owner];

  if _conname is not null then
    execute format('alter table {{schema}}.principal drop constraint %I', _conname);
  end if;
end $$;

alter table {{schema}}.principal
  alter column member_id set expression as
    (case when kind in ('u', 's') then id else null end)
;

alter table {{schema}}.principal
  drop column if exists owner_id
, drop column if exists agent_id
;

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
  and c.conkey @> array[_kind] and c.conkey <@ array[_kind];

  if _conname is not null then
    execute format('alter table {{schema}}.principal drop constraint %I', _conname);
  end if;
end $$;

alter table {{schema}}.principal
  add constraint principal_kind_check check (kind in ('g', 'u', 's'))
;

alter table {{schema}}.principal
  drop constraint if exists principal_agent_group_name_check
, drop constraint if exists principal_handle_name_check
, add constraint principal_handle_name_check check
  (
    kind not in ('g', 's')
    or name::text ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
  )
;
