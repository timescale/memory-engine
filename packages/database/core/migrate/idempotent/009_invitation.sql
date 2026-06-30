-- A pending email invitation is redeemed by explicit acceptance, never auto-join.
-- The old bulk login-time redemption is gone; drop it so an existing dev/prod DB
-- does not keep the removed function as an orphan.
drop function if exists {{schema}}.redeem_space_invitations(uuid, citext);

-------------------------------------------------------------------------------
-- create_space_invitation
-- Issue an invitation to a space. _email set → an email-constrained invite
-- (only that verified email may redeem, single-use), keyed so re-inviting the
-- same email upserts the pending row; _email null → an open shareable link
-- (any logged-in user may redeem). Every invite carries a magic-link token
-- (_token_lookup + sha256 _token_hash). _share_access null = no share grant;
-- _expires_at / _max_uses bound an open link (ignored for single-use email
-- invites). Returns the id.
-------------------------------------------------------------------------------
{{fn create_space_invitation(_space_id uuid, _email citext, _admin bool, _share_access int, _invited_by uuid, _token_lookup text, _token_hash text, _expires_at timestamptz, _max_uses int) returns uuid}}
create or replace function {{schema}}.create_space_invitation
( _space_id     uuid
, _email        citext
, _admin        bool
, _share_access int
, _invited_by   uuid
, _token_lookup text
, _token_hash   text
, _expires_at   timestamptz
, _max_uses     int
)
returns uuid
as $func$
  insert into {{schema}}.space_invitation
    (space_id, email, admin, share_access, invited_by, token_lookup, token_hash, expires_at, max_uses)
  values
    (_space_id, _email, _admin, _share_access, _invited_by, _token_lookup, _token_hash, _expires_at, _max_uses)
  -- re-inviting the same email upserts the pending row (matches the partial
  -- unique index predicate). Open links (email null) never conflict here.
  on conflict (space_id, email) where email is not null and accepted_at is null and revoked_at is null do update set
    admin = excluded.admin
  , share_access = excluded.share_access
  , invited_by = excluded.invited_by -- updated_at maintained by the before-update trigger
  , token_lookup = excluded.token_lookup
  , token_hash = excluded.token_hash
  , expires_at = excluded.expires_at
  , max_uses = excluded.max_uses
  returning id
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}

-------------------------------------------------------------------------------
-- list_space_invitations
-- Active invitations for a space — both email-constrained invites and open
-- links (kind = 'email' | 'link') — with the inviter's display name, the open-
-- link bounds (expires_at / max_uses), and the redemption count (uses). Excludes
-- accepted (single-use, consumed) and revoked rows. Never returns the token.
-------------------------------------------------------------------------------
{{fn list_space_invitations(_space_id uuid) returns table(id uuid, email text, admin bool, share_access int, invited_by uuid, invited_by_name text, created_at timestamptz, kind text, expires_at timestamptz, max_uses int, uses int)}}
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
, kind text
, expires_at timestamptz
, max_uses int
, uses int
)
as $func$
  select i.id, i.email::text, i.admin, i.share_access, i.invited_by, p.name::text, i.created_at
       , case when i.email is null then 'link' else 'email' end
       , i.expires_at, i.max_uses
       , (select count(*)::int from {{schema}}.space_invitation_redemption r where r.invitation_id = i.id)
  from {{schema}}.space_invitation i
  left join {{schema}}.principal p on p.id = i.invited_by
  where i.space_id = _space_id
  and i.accepted_at is null
  and i.revoked_at is null
  order by i.created_at
$func$ language sql stable strict security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}

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
  and i.revoked_at is null
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
  and i.revoked_at is null
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

-------------------------------------------------------------------------------
-- redeem_invitation
-- Redeem a magic-link token: validate the token (lookup + sha256 hash equality),
-- not revoked, not expired. If the invite is email-constrained, only the
-- matching verified email may redeem and it is single-use (consumed via
-- accepted_at); if it is an open link, any user may redeem, bounded by max_uses
-- across distinct redeemers. Joins the space (owner@home + share level) and
-- records the redemption. Returns the joined space, or no rows on any failure.
-- The for-update lock on the invite row serializes concurrent redemptions of the
-- same link (so the max_uses count is consistent).
-------------------------------------------------------------------------------
create or replace function {{schema}}.redeem_invitation
( _token_lookup text
, _token_hash   text
, _user_id      uuid
, _user_email   citext
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
  if _token_lookup is null or _token_hash is null then
    return;
  end if;

  select i.id, i.space_id, i.email, i.admin, i.share_access, i.token_hash
       , i.accepted_at, i.max_uses
  into inv
  from {{schema}}.space_invitation i
  where i.token_lookup = _token_lookup
  and i.revoked_at is null
  and (i.expires_at is null or i.expires_at > pg_catalog.now())
  for update;

  -- not found / hash mismatch (constant-ish: still requires the row)
  if not found or inv.token_hash is distinct from _token_hash then
    return;
  end if;

  if inv.email is not null then
    -- email-constrained: only the matching verified email, single-use.
    if inv.email <> _user_email or inv.accepted_at is not null then
      return;
    end if;
  else
    -- open link: bounded by max_uses across distinct redeemers.
    if inv.max_uses is not null
       and (select count(*) from {{schema}}.space_invitation_redemption r
            where r.invitation_id = inv.id) >= inv.max_uses then
      return;
    end if;
  end if;

  perform {{schema}}._join_via_invitation(inv.space_id, _user_id, inv.admin, inv.share_access);
  insert into {{schema}}.space_invitation_redemption (invitation_id, user_id)
  values (inv.id, _user_id)
  on conflict (invitation_id, user_id) do nothing;
  if inv.email is not null then
    update {{schema}}.space_invitation set accepted_at = pg_catalog.now() where id = inv.id;
  end if;

  return query
    select s.id, s.slug, s.name::text, inv.admin, inv.share_access
    from {{schema}}.space s
    where s.id = inv.space_id;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- revoke_invitation_by_id
-- Revoke any invitation by id (an open link or an email invite) by stamping
-- revoked_at — it then disappears from the lists and can no longer be redeemed.
-- (Email invites can also be deleted by email via revoke_space_invitation.)
-- Returns true if an active row was revoked.
-------------------------------------------------------------------------------
create or replace function {{schema}}.revoke_invitation_by_id
( _space_id      uuid
, _invitation_id uuid
)
returns bool
as $func$
  with u as
  (
    update {{schema}}.space_invitation
    set revoked_at = pg_catalog.now()
    where id = _invitation_id
    and space_id = _space_id
    and revoked_at is null
    and accepted_at is null
    returning 1
  )
  select exists (select 1 from u)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
