-- A pending email invitation is redeemed by explicit acceptance, never auto-join.
-- The old bulk login-time redemption is gone; drop it so an existing dev/prod DB
-- does not keep the removed function as an orphan.
drop function if exists {{schema}}.redeem_space_invitations(uuid, citext);

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
-- _join_via_invitation
-- The shared join body for accepting an invitation: add the user to the space
-- (add_principal_to_space also grants owner@home) and, when a share level is
-- set, grant it at the shared root 'share'. Used by accept_space_invitation
-- (and, in the magic-link work, redeem_invitation) so both paths join the same
-- way. Caller is responsible for stamping accepted_at / recording redemption.
-------------------------------------------------------------------------------
create or replace function {{schema}}._join_via_invitation
( _space_id     uuid
, _user_id      uuid
, _admin        bool
, _share_access int
)
returns void
as $func$
begin
  perform {{schema}}.add_principal_to_space(_space_id, _user_id, _admin);
  if _share_access is not null then
    perform {{schema}}.grant_tree_access(_space_id, _user_id, 'share'::ltree, _share_access);
  end if;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- list_pending_invitations_for_email
-- Every pending invitation addressed to an email, across all spaces — the
-- invitee's view of what they can accept. email is citext, so the match is
-- case-insensitive. Includes the space slug/name and the inviter's display name
-- when still resolvable.
-------------------------------------------------------------------------------
create or replace function {{schema}}.list_pending_invitations_for_email
( _email citext
)
returns table
( invitation_id   uuid
, space_id        uuid
, slug            text
, name            text
, admin           bool
, share_access    int
, invited_by_name text
, created_at      timestamptz
)
as $func$
  select i.id, i.space_id, s.slug, s.name::text, i.admin, i.share_access, p.name::text, i.created_at
  from {{schema}}.space_invitation i
  join {{schema}}.space s on s.id = i.space_id
  left join {{schema}}.principal p on p.id = i.invited_by
  where i.email = _email
  and i.accepted_at is null
  order by i.created_at
$func$ language sql stable strict security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- accept_space_invitation
-- Explicitly accept ONE pending invitation, identified by id, only if it is
-- addressed to _email (the caller's verified email — the email-keyed gate) and
-- still pending. Joins the space (owner@home + the per-invite share level) and
-- stamps accepted_at. Idempotent: a second call finds nothing pending. Returns
-- the joined space (one row), or no rows on mismatch / not-found / already
-- accepted. The user must already exist as a core principal.
-------------------------------------------------------------------------------
create or replace function {{schema}}.accept_space_invitation
( _user_id       uuid
, _email         citext
, _invitation_id uuid
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
  select i.id, i.space_id, i.admin, i.share_access
  into inv
  from {{schema}}.space_invitation i
  where i.id = _invitation_id
  and i.email = _email
  and i.accepted_at is null
  for update;

  if not found then
    return;
  end if;

  perform {{schema}}._join_via_invitation(inv.space_id, _user_id, inv.admin, inv.share_access);
  update {{schema}}.space_invitation set accepted_at = pg_catalog.now() where id = inv.id;

  return query
    select s.id, s.slug, s.name::text, inv.admin, inv.share_access
    from {{schema}}.space s
    where s.id = inv.space_id;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- decline_space_invitation
-- Decline (delete) ONE pending invitation by id, gated on _email so a caller
-- can only decline an invitation addressed to their own verified email. Returns
-- true if a pending row was removed.
-------------------------------------------------------------------------------
create or replace function {{schema}}.decline_space_invitation
( _email         citext
, _invitation_id uuid
)
returns bool
as $func$
  with d as
  (
    delete from {{schema}}.space_invitation
    where id = _invitation_id
    and email = _email
    and accepted_at is null
    returning 1
  )
  select exists (select 1 from d)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
