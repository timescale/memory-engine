-------------------------------------------------------------------------------
-- is_principal_in_space
-------------------------------------------------------------------------------
create or replace function core.is_principal_in_space
( _principal_id uuid
, _space_id uuid
)
returns bool
as $func$
  select exists
  (
    select 1
    from core.principal_space ps
    where ps.principal_id = _principal_id
    and ps.space_id = _space_id
  )
$func$ language sql stable security invoker
;

-------------------------------------------------------------------------------
-- is_principal_space_admin
-------------------------------------------------------------------------------
create or replace function core.is_principal_space_admin
( _principal_id uuid
, _space_id uuid
)
returns bool
as $func$
  select coalesce
  (
    (
      select ps.admin and (not p.kind = 'a') -- agents cannot be space admins
      from core.principal_space ps
      inner join core.principal p on (ps.principal_id = p.id)
      where ps.principal_id = _principal_id
      and ps.space_id = _space_id
    )
  , false
  )
$func$ language sql stable security invoker
;
