
-------------------------------------------------------------------------------
-- member_groups
-------------------------------------------------------------------------------
create or replace function core.member_groups
( _member_id uuid
, _space_id uuid
)
returns table
( group_id uuid
, admin bool
)
as $func$
  select
    gm.group_id
  , gm.admin and (not m.kind = 'a') -- agent's cannot be group admins
  from core.principal m -- the member
  -- assert the member belongs to the space
  inner join core.principal_space psm on (m.id = psm.principal_id and psm.space_id = _space_id)
  -- find the groups the member belongs to in the space
  inner join core.group_member gm on (m.member_id = gm.member_id and gm.space_id = _space_id)
  -- assert the group belongs to the space
  inner join core.principal_space psg on (gm.group_id = psg.principal_id and psg.space_id = _space_id)
  where m.member_id = _member_id -- the member
$func$ language sql stable security invoker
;
