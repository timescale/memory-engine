-------------------------------------------------------------------------------
-- create_space_invitation
-- Issue (or update, if one is already pending) an invitation to a space, keyed
-- by invitee email. _share_access null means no share grant; otherwise it is
-- the level (1/2/3) granted at the shared root on redemption. Returns the id.
-------------------------------------------------------------------------------
create or replace function {{schema}}.create_space_invitation
( _space_id     uuid
, _email        citext
, _admin        bool
, _share_access int
, _invited_by   uuid
)
returns uuid
as $func$
  insert into {{schema}}.space_invitation (space_id, email, admin, share_access, invited_by)
  values (_space_id, _email, _admin, _share_access, _invited_by)
  on conflict (space_id, email) where accepted_at is null do update set
    admin = excluded.admin
  , share_access = excluded.share_access
  , invited_by = excluded.invited_by -- updated_at maintained by the before-update trigger
  returning id
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- list_space_invitations
-- Pending invitations for a space (accepted ones are history), with the
-- inviter's display name when still resolvable.
-------------------------------------------------------------------------------
create or replace function {{schema}}.list_space_invitations
( _space_id uuid
)
returns table
( id uuid
, email text
, admin bool
, share_access int
, invited_by uuid
, invited_by_name text
, created_at timestamptz
)
as $func$
  select i.id, i.email::text, i.admin, i.share_access, i.invited_by, p.name::text, i.created_at
  from {{schema}}.space_invitation i
  left join {{schema}}.principal p on p.id = i.invited_by
  where i.space_id = _space_id
  and i.accepted_at is null
  order by i.created_at
$func$ language sql stable strict security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- revoke_space_invitation
-- Delete a pending invitation by email. Returns true if one was removed. An
-- already-accepted invitation is not revocable here (the user is a member;
-- use remove_principal_from_space).
-------------------------------------------------------------------------------
create or replace function {{schema}}.revoke_space_invitation
( _space_id uuid
, _email    citext
)
returns bool
as $func$
  with d as
  (
    delete from {{schema}}.space_invitation
    where space_id = _space_id
    and email = _email
    and accepted_at is null
    returning 1
  )
  select exists (select 1 from d)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- redeem_space_invitations
-- Redeem every pending invitation for a (now-registered, verified) email: join
-- the user to each space (add_principal_to_space also grants owner@home), grant
-- access at the shared root 'share' when share_access is set, and stamp
-- accepted_at. Idempotent — a second call finds nothing pending. The user must
-- already exist as a core principal. Returns one row per space joined.
-------------------------------------------------------------------------------
create or replace function {{schema}}.redeem_space_invitations
( _user_id uuid
, _email   citext
)
returns table
( space_id     uuid
, slug         text
, name         text
, admin        bool
, share_access int
)
as $func$
declare
  inv record;
begin
  for inv in
    select i.id, i.space_id, i.admin, i.share_access
    from {{schema}}.space_invitation i
    where i.email = _email
    and i.accepted_at is null
    for update
  loop
    perform {{schema}}.add_principal_to_space(inv.space_id, _user_id, inv.admin);
    if inv.share_access is not null then
      perform {{schema}}.grant_tree_access(inv.space_id, _user_id, 'share'::ltree, inv.share_access);
    end if;
    update {{schema}}.space_invitation set accepted_at = pg_catalog.now() where id = inv.id;
    return query
      select s.id, s.slug, s.name::text, inv.admin, inv.share_access
      from {{schema}}.space s
      where s.id = inv.space_id;
  end loop;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
