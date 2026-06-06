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
-- member of a group whose own space-membership is admin (admin transfers
-- transitively through groups, like access does — Model 2). Agents are never
-- space admins.
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
      -- admin inherited from an admin group the principal belongs to
      or exists
      (
        select 1
        from {{schema}}.group_member gm
        inner join {{schema}}.principal_space gps
          on (gps.principal_id = gm.group_id and gps.space_id = _space_id and gps.admin)
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
-- user who is a direct admin (principal_space.admin) OR a member of an
-- admin-flagged group. Agents are never admins, and an admin-flagged group with
-- no user members does NOT count. Checking the effective set (not just the
-- principal_space.admin flag) closes the brick where a space's sole admin is an
-- empty admin group, leaving it unrecoverable.
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
    -- or a user member of an admin-flagged group
    or exists
    (
      select 1
      from {{schema}}.group_member gm
      join {{schema}}.principal_space gps
        on gps.principal_id = gm.group_id and gps.space_id = gm.space_id and gps.admin
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

-- principal_space: fire only when an admin row is removed or demoted (NEW can't
-- be referenced in a DELETE trigger's WHEN, hence two). group_member: fire on any
-- removal; the fn early-outs unless the group is an admin group.
create or replace trigger principal_space_keep_admin_del
after delete on {{schema}}.principal_space
for each row when (old.admin)
execute function {{schema}}.enforce_last_admin();

create or replace trigger principal_space_keep_admin_upd
after update on {{schema}}.principal_space
for each row when (old.admin and not new.admin)
execute function {{schema}}.enforce_last_admin();

create or replace trigger group_member_keep_admin_del
after delete on {{schema}}.group_member
for each row
execute function {{schema}}.enforce_last_admin();
