-- Tier 2 integrity hardening (FM2): pin group_member.space_id to the group's
-- own space, structurally.
--
-- group_member already constrains group_id -> a group and member_id -> a u/a via
-- single-column FKs, but nothing tied group_member.space_id to the GROUP's space
-- (principal.space_id). A row could therefore name a group from space A while
-- tagged space B — incoherent (its grants live in A, so it is inert in B) and a
-- latent integrity smell. Replace the single-column group FK with a COMPOSITE
-- (group_id, space_id) FK into principal so the space must match the group's own.
--
-- This needs no trigger: a group's principal.space_id is set at creation and
-- never updated, so the composite FK fully expresses the invariant.

-- 1. Referenced key: principal(group_id, space_id) must carry a unique
--    constraint to be an FK target. group_id is already unique (generated; null
--    for non-groups, so the pair is (null, null) and distinct for u/a), so the
--    pair is trivially unique — this just makes it referenceable.
alter table {{schema}}.principal
  add constraint principal_group_id_space_id_key unique (group_id, space_id);

-- 2. Drop the old single-column group_id FK (group_member.group_id ->
--    principal(group_id)). Discover its name rather than assuming the
--    auto-generated one, then drop it; the composite below subsumes it.
do $$
declare
  _conname text;
begin
  select c.conname into _conname
  from pg_constraint c
  where c.conrelid = '{{schema}}.group_member'::regclass
    and c.contype = 'f'
    and c.confrelid = '{{schema}}.principal'::regclass
    and c.conkey = array[
      ( select a.attnum
        from pg_attribute a
        where a.attrelid = '{{schema}}.group_member'::regclass
        and a.attname = 'group_id'
      )
    ];
  if _conname is not null then
    execute format(
      'alter table {{schema}}.group_member drop constraint %I', _conname
    );
  end if;
end $$;

-- 3. Composite FK: a group_member row's (group_id, space_id) must match the
--    group's own principal row, so a membership can never be tagged with a space
--    other than the group's. Cascades on group deletion, as the old FK did.
alter table {{schema}}.group_member
  add constraint group_member_group_id_space_id_fkey
  foreign key (group_id, space_id)
  references {{schema}}.principal (group_id, space_id)
  on delete cascade;
