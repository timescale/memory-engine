-- A pending email invitation is redeemed by explicit acceptance, never auto-join.
-- The old bulk login-time redemption is gone; drop it so an existing dev/prod DB
-- does not keep the removed function as an orphan.
drop function if exists {{schema}}.redeem_space_invitations(uuid, citext);

-------------------------------------------------------------------------------
-- _invitation_valid
-- The single source of truth for "can this invitation still be redeemed by an
-- eligible user right now". Every read/accept/redeem path goes through it so the
-- validity rules can't drift: not revoked, not expired, and not exhausted —
-- where exhaustion is the single-use accepted_at for an email invite, or the
-- max_uses redemption cap for an open link (null = unlimited). It does NOT check
-- WHO may redeem (the email match / token) — that's the caller's gate. Defined
-- first so the SQL-language list functions below can reference it at creation.
-------------------------------------------------------------------------------
create or replace function {{schema}}._invitation_valid
( _invitation_id uuid
)
returns bool
as $func$
  select i.revoked_at is null
     and i.declined_at is null
     and (i.expires_at is null or i.expires_at > pg_catalog.now())
     -- single-use email invite: consumed once accepted_at is stamped.
     and i.accepted_at is null
     -- open link (email null): bounded by max_uses across distinct redeemers.
     and (
       i.email is not null
       or i.max_uses is null
       or (
         select count(*)
         from {{schema}}.space_invitation_redemption r
         where r.invitation_id = i.id
       ) < i.max_uses
     )
  from {{schema}}.space_invitation i
  where i.id = _invitation_id
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- _group_names
-- The display names of an invitation's target groups: the names of the groups
-- in `_group_ids` that still exist in `_space_id` (a group deleted since the
-- invite was created simply drops out). Ordered by name for a stable list.
-- Returns '{}' when none survive. Shared by the list / accept / redeem readers.
-------------------------------------------------------------------------------
create or replace function {{schema}}._group_names
( _space_id  uuid
, _group_ids uuid[]
)
returns text[]
as $func$
  select coalesce(array_agg(p.name::text order by p.name), '{}')
  from unnest(_group_ids) gid
  join {{schema}}.principal p on p.group_id = gid and p.space_id = _space_id
$func$ language sql stable security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- create_space_invitation
-- Issue an invitation to a space. _email set → an email-constrained invite
-- (only that verified email may redeem, single-use), keyed so re-inviting the
-- same email upserts the pending row; _email null → an open shareable link
-- (any logged-in user may redeem). Every invite carries a raw magic-link token
-- (_token, stored as-is so the URL can be re-copied). _group_ids are the groups
-- the redeemer is added to on join — their grants ARE the joiner's access (there
-- is no per-invite share grant); each must be a group in _space_id (enforced by
-- the enforce_invitation_groups_coherence trigger), and duplicates are collapsed.
-- _expires_at / _max_uses bound an open link (ignored for single-use email
-- invites). Returns the id.
-------------------------------------------------------------------------------
{{fn create_space_invitation(_space_id uuid, _email citext, _admin bool, _group_ids uuid[], _invited_by uuid, _token text, _expires_at timestamptz, _max_uses int) returns uuid}}
create or replace function {{schema}}.create_space_invitation
( _space_id   uuid
, _email      citext
, _admin      bool
, _group_ids  uuid[]
, _invited_by uuid
, _token      text
, _expires_at timestamptz
, _max_uses   int
)
returns uuid
as $func$
  insert into {{schema}}.space_invitation
    (space_id, email, admin, group_ids, invited_by, token, expires_at, max_uses)
  values
    ( _space_id, _email, _admin
    , (select array(select distinct unnest(_group_ids))) -- dedupe
    , _invited_by, _token, _expires_at, _max_uses
    )
  -- re-inviting the same email upserts the active pending row (matches the
  -- partial unique index predicate). Open links (email null) never conflict here.
  on conflict (space_id, email) where email is not null and accepted_at is null and revoked_at is null and declined_at is null do update set
    admin = excluded.admin
  , group_ids = excluded.group_ids
  , invited_by = excluded.invited_by -- updated_at maintained by the before-update trigger
  , token = excluded.token
  , expires_at = excluded.expires_at
  , max_uses = excluded.max_uses
  returning id
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}

-------------------------------------------------------------------------------
-- list_space_invitations
-- The admin management view: non-terminal invitations for a space — both email-
-- constrained invites and open links (kind = 'email' | 'link') — with the
-- inviter's display name, the open-link bounds (expires_at / max_uses), the
-- redemption count (uses), a derived `valid` flag (_invitation_valid), and the
-- raw token (admin-only — this RPC is space-admin-gated — so the URL can be
-- re-copied). It deliberately still lists expired / exhausted (but not yet
-- revoked) rows so the admin can see they lapsed; `valid = false` marks them.
-- Excludes accepted (consumed), revoked, and declined rows.
-------------------------------------------------------------------------------
{{fn list_space_invitations(_space_id uuid) returns table(id uuid, email text, admin bool, group_ids uuid[], group_names text[], invited_by uuid, invited_by_name text, created_at timestamptz, kind text, expires_at timestamptz, max_uses int, uses int, valid bool, token text)}}
create or replace function {{schema}}.list_space_invitations
( _space_id uuid
)
returns table
( id uuid
, email text
, admin bool
, group_ids uuid[]
, group_names text[]
, invited_by uuid
, invited_by_name text
, created_at timestamptz
, kind text
, expires_at timestamptz
, max_uses int
, uses int
, valid bool
, token text
)
as $func$
  select i.id, i.email::text, i.admin, i.group_ids, {{schema}}._group_names(i.space_id, i.group_ids), i.invited_by, p.name::text, i.created_at
       , case when i.email is null then 'link' else 'email' end
       , i.expires_at, i.max_uses
       , (select count(*)::int from {{schema}}.space_invitation_redemption r where r.invitation_id = i.id)
       , {{schema}}._invitation_valid(i.id)
       , i.token
  from {{schema}}.space_invitation i
  left join {{schema}}.principal p on p.id = i.invited_by
  where i.space_id = _space_id
  and i.accepted_at is null
  and i.revoked_at is null
  and i.declined_at is null
  order by i.created_at
$func$ language sql stable strict security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}

-------------------------------------------------------------------------------
-- revoke_space_invitation
-- Revoke the active pending invitation for an email by stamping revoked_at (a
-- soft delete — the row persists for audit). Returns true if one was revoked. An
-- already-accepted invitation is not revocable here (the user is a member; use
-- remove_principal_from_space); an already-revoked/declined one is a no-op.
-------------------------------------------------------------------------------
create or replace function {{schema}}.revoke_space_invitation
( _space_id uuid
, _email    citext
)
returns bool
as $func$
  with u as
  (
    update {{schema}}.space_invitation
    set revoked_at = pg_catalog.now()
    where space_id = _space_id
    and email = _email
    and accepted_at is null
    and revoked_at is null
    and declined_at is null
    returning 1
  )
  select exists (select 1 from u)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- _join_via_invitation
-- The shared body for accepting / redeeming an invitation, identified by id —
-- the single place both accept_space_invitation and redeem_invitation go through
-- so the two are identical by construction:
--   1. join the space (add_principal_to_space also grants owner@home) and add the
--      redeemer to every one of the invitation's groups — but ONLY for a
--      not-yet-member. add_principal_to_space upserts admin = excluded.admin, so
--      joining an existing member would silently overwrite their role (demoting an
--      admin, or aborting with LAST_ADMIN if they were the last one). For an
--      existing member this is therefore a no-op — redeeming an invite never
--      changes a role or group membership you already have;
--   2. record a space_invitation_redemption row (who joined via this invite) —
--      so the audit trail is the same whether joined by accept or by token;
--   3. for a single-use email invite (email is not null), stamp accepted_at to
--      consume it; an open link (email null) leaves accepted_at null and stays
--      multi-use, bounded by max_uses.
-- The granted privileges (admin, groups, target space) are read from the
-- invitation row itself — never passed in — so no caller can join a user with
-- more access than the invitation specifies. The joiner's tree access is the
-- union of the groups' grants (there is no per-invite share grant). Groups
-- deleted since the invite was created are skipped (the join to principal filters
-- to groups that still exist in the space). A no-op if the invitation is gone.
-------------------------------------------------------------------------------
{{fn _join_via_invitation(_invitation_id uuid, _user_id uuid) returns void}}
create or replace function {{schema}}._join_via_invitation
( _invitation_id uuid
, _user_id       uuid
)
returns void
as $func$
declare
  inv  record;
  _gid uuid;
begin
  select space_id, email, admin, group_ids
  into inv
  from {{schema}}.space_invitation
  where id = _invitation_id;

  if not found then
    return;
  end if;

  -- Only join for a not-yet-member; never overwrite an existing member's role or
  -- group memberships (see header). Add the member to every group in group_ids
  -- that still exists in the space (whose grants become the joiner's access);
  -- the join filters out any group deleted since the invite was created, and we
  -- route through add_group_member so group-membership logic stays in one place.
  if not exists (
    select 1 from {{schema}}.principal_space ps
    where ps.space_id = inv.space_id and ps.principal_id = _user_id
  ) then
    perform {{schema}}.add_principal_to_space(inv.space_id, _user_id, inv.admin);
    for _gid in
      select p.group_id
      from unnest(inv.group_ids) gid
      join {{schema}}.principal p on p.group_id = gid and p.space_id = inv.space_id
    loop
      perform {{schema}}.add_group_member(inv.space_id, _gid, _user_id);
    end loop;
  end if;

  -- audit: one row per (invitation, user) — both accept and redeem record it.
  insert into {{schema}}.space_invitation_redemption (invitation_id, user_id)
  values (_invitation_id, _user_id)
  on conflict (invitation_id, user_id) do nothing;

  -- single-use email invite → consume it; open links stay multi-use.
  if inv.email is not null then
    update {{schema}}.space_invitation set accepted_at = pg_catalog.now()
    where id = _invitation_id;
  end if;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}

-------------------------------------------------------------------------------
-- list_pending_invitations_for_email
-- Every currently-valid invitation addressed to an email, across all spaces —
-- the invitee's view of what they can accept (excludes accepted / revoked /
-- expired). email is citext, so the match is case-insensitive. Includes the
-- space slug/name, the group the invite joins them to, and the inviter's display
-- name when still resolvable.
-------------------------------------------------------------------------------
{{fn list_pending_invitations_for_email(_email citext) returns table(invitation_id uuid, space_id uuid, slug text, name text, admin bool, group_names text[], invited_by_name text, created_at timestamptz)}}
create or replace function {{schema}}.list_pending_invitations_for_email
( _email citext
)
returns table
( invitation_id   uuid
, space_id        uuid
, slug            text
, name            text
, admin           bool
, group_names     text[]
, invited_by_name text
, created_at      timestamptz
)
as $func$
  select i.id, i.space_id, s.slug, s.name::text, i.admin, {{schema}}._group_names(i.space_id, i.group_ids), p.name::text, i.created_at
  from {{schema}}.space_invitation i
  join {{schema}}.space s on s.id = i.space_id
  left join {{schema}}.principal p on p.id = i.invited_by
  where i.email = _email
  and {{schema}}._invitation_valid(i.id)
  order by i.created_at
$func$ language sql stable strict security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}

-------------------------------------------------------------------------------
-- accept_space_invitation
-- Explicitly accept ONE pending invitation, identified by id, only if it is
-- addressed to _email (the caller's verified email — the email-keyed gate) and
-- still valid. Joins via _join_via_invitation (which joins the space, adds the
-- user to the invite's groups, records the redemption, and consumes the
-- single-use email invite). Idempotent: a second call finds nothing valid.
-- Returns the joined space + group names (one row), or no rows on mismatch /
-- not-found / already-accepted. The user must already be a principal.
-------------------------------------------------------------------------------
{{fn accept_space_invitation(_user_id uuid, _email citext, _invitation_id uuid) returns table(space_id uuid, slug text, name text, admin bool, group_names text[])}}
create or replace function {{schema}}.accept_space_invitation
( _user_id       uuid
, _email         citext
, _invitation_id uuid
)
returns table
( space_id    uuid
, slug        text
, name        text
, admin       bool
, group_names text[]
)
as $func$
declare
  inv record;
begin
  -- Lock the row addressed to this email; validity (expired / revoked / already
  -- accepted) is the shared _invitation_valid gate.
  select i.id, i.space_id, i.admin, i.group_ids
  into inv
  from {{schema}}.space_invitation i
  where i.id = _invitation_id
  and i.email = _email
  for update;

  if not found or not {{schema}}._invitation_valid(inv.id) then
    return;
  end if;

  perform {{schema}}._join_via_invitation(inv.id, _user_id);

  return query
    select s.id, s.slug, s.name::text, inv.admin, {{schema}}._group_names(inv.space_id, inv.group_ids)
    from {{schema}}.space s
    where s.id = inv.space_id;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}

-------------------------------------------------------------------------------
-- decline_space_invitation
-- Decline ONE active invitation by id by stamping declined_at (a soft delete —
-- the row persists for audit, and re-inviting the email is allowed since the
-- pending-unique index excludes declined rows). Gated on _email so a caller can
-- only decline an invitation addressed to their own verified email. Returns true
-- if an active row was declined.
-------------------------------------------------------------------------------
create or replace function {{schema}}.decline_space_invitation
( _email         citext
, _invitation_id uuid
)
returns bool
as $func$
  with u as
  (
    update {{schema}}.space_invitation
    set declined_at = pg_catalog.now()
    where id = _invitation_id
    and email = _email
    and accepted_at is null
    and revoked_at is null
    and declined_at is null
    returning 1
  )
  select exists (select 1 from u)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- redeem_invitation
-- Redeem a magic-link token (matched raw, by equality): not revoked, not
-- expired, not exhausted. If the invite is email-constrained, only the matching
-- verified email may redeem and it is single-use (consumed via accepted_at); if
-- it is an open link, any user may redeem, bounded by max_uses across distinct
-- redeemers. Joins the space (owner@home) and the invite's groups, and records
-- the redemption. Returns the joined space + group names, or no rows on any
-- failure. The for-update lock on the invite row serializes concurrent
-- redemptions of the same link (so the max_uses count is consistent).
-------------------------------------------------------------------------------
{{fn redeem_invitation(_token text, _user_id uuid, _user_email citext) returns table(space_id uuid, slug text, name text, admin bool, group_names text[])}}
create or replace function {{schema}}.redeem_invitation
( _token      text
, _user_id    uuid
, _user_email citext
)
returns table
( space_id    uuid
, slug        text
, name        text
, admin       bool
, group_names text[]
)
as $func$
declare
  inv record;
begin
  if _token is null then
    return;
  end if;

  -- Lock the row by its token; the for-update lock serializes concurrent
  -- redemptions of the same link so _invitation_valid's max_uses count is
  -- consistent.
  select i.id, i.space_id, i.email, i.admin, i.group_ids
  into inv
  from {{schema}}.space_invitation i
  where i.token = _token
  for update;

  if not found then
    return;
  end if;

  -- shared validity (revoked / expired / declined / single-use / max_uses) ...
  if not {{schema}}._invitation_valid(inv.id) then
    return;
  end if;

  -- ... and the WHO gate: an email-constrained link only its matching email.
  -- NULL-safe: a null caller email must NOT satisfy the constraint (a plain `<>`
  -- yields NULL and would let it through).
  if inv.email is not null and inv.email is distinct from _user_email then
    return;
  end if;

  -- _join_via_invitation grants access, records the redemption, and (for an
  -- email invite) consumes it — identical to accept_space_invitation.
  perform {{schema}}._join_via_invitation(inv.id, _user_id);

  return query
    select s.id, s.slug, s.name::text, inv.admin, {{schema}}._group_names(inv.space_id, inv.group_ids)
    from {{schema}}.space s
    where s.id = inv.space_id;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
{{endfn}}

-------------------------------------------------------------------------------
-- revoke_invitation_by_id
-- Revoke any active invitation by id (an open link or an email invite) by
-- stamping revoked_at — it then disappears from the lists and can no longer be
-- redeemed. (Email invites can also be revoked by email via
-- revoke_space_invitation.) A no-op on an already-terminal row. Returns true if
-- an active row was revoked.
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
    and accepted_at is null
    and revoked_at is null
    and declined_at is null
    returning 1
  )
  select exists (select 1 from u)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- enforce_invitation_groups_coherence (trigger fn on space_invitation)
-- A uuid[] cannot carry a foreign key, so this is the table-level backstop that
-- the retired single-group composite FK used to provide: every element of
-- group_ids must be a GROUP (principal.group_id is non-null only for kind='g')
-- in the invitation's own space_id. Guards create_space_invitation and any direct
-- insert/update. It only validates at write time — a group deleted *after*
-- creation is handled at redemption instead (_join_via_invitation skips it).
-------------------------------------------------------------------------------
create or replace function {{schema}}.enforce_invitation_groups_coherence()
returns trigger
as $func$
begin
  if exists
  (
    select 1
    from unnest(new.group_ids) gid
    where not exists
    (
      select 1
      from {{schema}}.principal p
      where p.group_id = gid
      and p.space_id = new.space_id
    )
  ) then
    raise exception
      'invitation % references a group that is not a group in space %', new.id, new.space_id
      using errcode = '23514'
      , hint = 'every group_ids element must be a group in the invitation''s space';
  end if;
  return null;
end;
$func$ language plpgsql
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-- Guarded like the other constraint triggers (they support neither CREATE OR
-- REPLACE nor IF NOT EXISTS): (re)create only when the live trigger isn't already
-- a deferred constraint trigger, so it upgrades a stale shape once and is a
-- lock-free no-op thereafter. Fires on insert and update.
do $$ begin
  if not exists
  (
    select 1 from pg_trigger
    where tgrelid = '{{schema}}.space_invitation'::regclass
    and tgname = 'space_invitation_groups_coherence'
    and tgconstraint <> 0 and tgdeferrable and tginitdeferred
  ) then
    drop trigger if exists space_invitation_groups_coherence on {{schema}}.space_invitation;
    create constraint trigger space_invitation_groups_coherence
    after insert or update on {{schema}}.space_invitation
    deferrable initially deferred
    for each row
    execute function {{schema}}.enforce_invitation_groups_coherence();
  end if;
end $$;
