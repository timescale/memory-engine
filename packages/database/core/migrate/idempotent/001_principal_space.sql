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
