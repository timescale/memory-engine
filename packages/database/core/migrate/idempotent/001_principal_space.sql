-------------------------------------------------------------------------------
-- is_principal_in_space
-------------------------------------------------------------------------------
create or replace function {{schema}}.is_principal_in_space
( _principal_id uuid
, _space_id uuid
)
returns bool
as $func$
  select exists
  (
    select 1
    from {{schema}}.principal_space ps
    where ps.principal_id = _principal_id
    and ps.space_id = _space_id
  )
$func$ language sql stable security invoker
;

-------------------------------------------------------------------------------
-- is_principal_space_admin
-- A principal is a space admin if it has a direct admin membership, OR it is a
-- direct member of the space (a principal_space row) who also belongs to a group
-- whose own space-membership is admin. Admin via a group requires direct
-- membership — group membership alone never confers space access. Agents are
-- never space admins.
-------------------------------------------------------------------------------
create or replace function {{schema}}.is_principal_space_admin
( _principal_id uuid
, _space_id uuid
)
returns bool
as $func$
  select exists
  (
    select 1
    from {{schema}}.principal p
    where p.id = _principal_id
    and p.kind <> 'a' -- agents cannot be space admins
    and
    (
      -- direct admin membership
      exists
      (
        select 1
        from {{schema}}.principal_space ps
        where ps.principal_id = p.id
        and ps.space_id = _space_id
        and ps.admin
      )
      -- admin inherited from an admin group the principal belongs to — but only
      -- if the principal is ALSO a direct member of the space (a principal_space
      -- row); group membership alone never confers space access
      or exists
      (
        select 1
        from {{schema}}.group_member gm
        inner join {{schema}}.principal_space gps
          on (gps.principal_id = gm.group_id and gps.space_id = _space_id and gps.admin)
        inner join {{schema}}.principal_space mps
          on (mps.principal_id = gm.member_id and mps.space_id = _space_id)
        where gm.member_id = p.id
        and gm.space_id = _space_id
      )
    )
  )
$func$ language sql stable security invoker
;

-------------------------------------------------------------------------------
-- enforce_last_admin (trigger fn on principal_space + group_member)
-- Invariant: a live space must always have at least one *effective* admin — a
-- user who is a direct admin (principal_space.admin) OR a direct member who
-- belongs to an admin-flagged group (admin via a group requires direct
-- membership). Agents are never admins, and an admin-flagged group whose user
-- members aren't direct space members does NOT count. Checking the effective set
-- (not just the principal_space.admin flag) closes the brick where a space's
-- sole admin is an empty/non-member admin group, leaving it unrecoverable.
--
-- Guards every path that could drop the effective set, uniformly:
--   * principal_space remove/demote — incl. a group losing its admin flag, and
--     delete_principal cascades (deleting an admin user or group);
--   * group_member removal from an admin group — incl. remove_principal_from_space
--     and delete_principal cascades (a user leaving the sole admin group).
--
-- Whole-space teardown is exempt: delete_space drops the core.space row and lets
-- the FK cascade scrub the roster, so by the time this fires the space row is
-- gone. The `for update` both detects that (no row -> skip) and serializes
-- concurrent admin removals on the same space (so two txns can't each drop a
-- different last-ish admin and race to zero).
-------------------------------------------------------------------------------
create or replace function {{schema}}.enforce_last_admin()
returns trigger
as $func$
begin
  -- group_member path: only an ADMIN group's membership can affect the effective
  -- admin set; non-admin group churn (the common case) returns immediately.
  if tg_table_name = 'group_member' then
    if not exists
    (
      select 1
      from {{schema}}.principal_space gps
      where gps.principal_id = old.group_id
      and gps.space_id = old.space_id
      and gps.admin
    ) then
      return null;
    end if;
  end if;

  perform 1 from {{schema}}.space s where s.id = old.space_id for update;
  if not found then
    return null; -- space is being deleted: teardown, not a demote/removal
  end if;

  if not
  (
    -- a direct admin user
    exists
    (
      select 1
      from {{schema}}.principal_space ps
      join {{schema}}.principal p on p.id = ps.principal_id
      where ps.space_id = old.space_id
      and ps.admin
      and p.kind = 'u'
    )
    -- or a user who is a direct member AND belongs to an admin-flagged group
    -- (admin via a group requires direct membership)
    or exists
    (
      select 1
      from {{schema}}.group_member gm
      join {{schema}}.principal_space gps
        on gps.principal_id = gm.group_id and gps.space_id = gm.space_id and gps.admin
      join {{schema}}.principal_space mps
        on mps.principal_id = gm.member_id and mps.space_id = gm.space_id
      join {{schema}}.principal mp on mp.id = gm.member_id and mp.kind = 'u'
      where gm.space_id = old.space_id
    )
  ) then
    raise exception
      'cannot leave space % without an effective admin', old.space_id
      using errcode = 'ME001'
      , hint = 'a space needs a user admin — direct, or via an admin group with at least one member';
  end if;

  return null;
end;
$func$ language plpgsql
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-- These are DEFERRABLE INITIALLY DEFERRED constraint triggers: the invariant is
-- judged once at the end of the transaction, against its final state — not per
-- statement. So a single txn that swaps admins (or otherwise churns the roster
-- before settling) is never tripped mid-flight by an intermediate state.
--
-- Constraint triggers support neither CREATE OR REPLACE nor IF NOT EXISTS, and a
-- bare drop+create would take an ACCESS EXCLUSIVE lock on these tables on every
-- migration run. So each is wrapped in a guard that drops+recreates only when the
-- live trigger isn't already the wanted shape (constraint + deferrable +
-- initially deferred): it upgrades a pre-existing plain trigger on first run,
-- then is a lock-free no-op on every run after. (The guard keys on shape, not the
-- full definition — changing a trigger's events or WHEN clause later needs a
-- one-time manual drop to force the recreate.)
--
-- principal_space: fire only when an admin row is removed or demoted (NEW can't
-- be referenced in a DELETE trigger's WHEN, hence two). group_member: fire on any
-- removal; the fn early-outs unless the group is an admin group.
do $$ begin
  if not exists
  (
    select 1 from pg_trigger
    where tgrelid = '{{schema}}.principal_space'::regclass
    and tgname = 'principal_space_keep_admin_del'
    and tgconstraint <> 0 and tgdeferrable and tginitdeferred
  ) then
    drop trigger if exists principal_space_keep_admin_del on {{schema}}.principal_space;
    create constraint trigger principal_space_keep_admin_del
    after delete on {{schema}}.principal_space
    deferrable initially deferred
    for each row when (old.admin)
    execute function {{schema}}.enforce_last_admin();
  end if;
end $$;

do $$ begin
  if not exists
  (
    select 1 from pg_trigger
    where tgrelid = '{{schema}}.principal_space'::regclass
    and tgname = 'principal_space_keep_admin_upd'
    and tgconstraint <> 0 and tgdeferrable and tginitdeferred
  ) then
    drop trigger if exists principal_space_keep_admin_upd on {{schema}}.principal_space;
    create constraint trigger principal_space_keep_admin_upd
    after update on {{schema}}.principal_space
    deferrable initially deferred
    for each row when (old.admin and not new.admin)
    execute function {{schema}}.enforce_last_admin();
  end if;
end $$;

do $$ begin
  if not exists
  (
    select 1 from pg_trigger
    where tgrelid = '{{schema}}.group_member'::regclass
    and tgname = 'group_member_keep_admin_del'
    and tgconstraint <> 0 and tgdeferrable and tginitdeferred
  ) then
    drop trigger if exists group_member_keep_admin_del on {{schema}}.group_member;
    create constraint trigger group_member_keep_admin_del
    after delete on {{schema}}.group_member
    deferrable initially deferred
    for each row
    execute function {{schema}}.enforce_last_admin();
  end if;
end $$;
