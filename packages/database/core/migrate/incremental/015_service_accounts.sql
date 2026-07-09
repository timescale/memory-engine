-------------------------------------------------------------------------------
-- service accounts: schema representation only.
--
-- This migration makes a service account representable in core.principal. The
-- lifecycle functions, bound-admin-group constraints, and effective-access
-- behavior land in later phases.
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

-- Replace the original kind check (`g|u|a`) with `g|u|a|s`.
alter table {{schema}}.principal
  drop constraint principal_kind_check
, add constraint principal_kind_check check (kind in ('g', 'u', 'a', 's'))
;

-- Groups and service accounts are space-scoped. Users and agents are global.
alter table {{schema}}.principal
  drop constraint principal_check1
, add constraint principal_space_scope_check check
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
