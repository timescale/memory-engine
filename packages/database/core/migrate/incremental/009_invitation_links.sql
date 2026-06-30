-- Magic-link invitations, unified into the existing space_invitation table.
-- Every link-capable invite carries an opaque token; `email`, when set, is a
-- constraint (only that verified email may redeem, single-use). When `email` is
-- null the invite is an open shareable link: any logged-in user may redeem it,
-- multi-use, bounded by an optional expiry / max-uses, revocable.

alter table {{schema}}.space_invitation
  -- the magic-link credential: the raw, opaque, high-entropy token, stored as-is
  -- (NOT hashed) so an admin can re-copy the invite URL — an invite link is a
  -- scoped, revocable, capped bearer link, not a show-once secret like an api
  -- key. Nullable: legacy email invites created before this migration have no
  -- token and stay accept-by-id only.
  add column token        text
  -- open-link knobs (ignored for email invites, which are single-use):
, add column expires_at   timestamptz                 -- null = never expires
, add column max_uses     int                         -- null = unlimited redemptions
  -- terminal states (soft delete): the row always persists for audit; an invite
  -- is "active" only while accepted_at / revoked_at / declined_at are all null.
, add column revoked_at   timestamptz                 -- admin killed it
, add column declined_at  timestamptz                 -- invitee said no
;

-- email is now optional: null = an open shareable link (not addressed to anyone).
alter table {{schema}}.space_invitation alter column email drop not null;

-- O(1) token lookup + uniqueness; partial so the many token-less legacy rows
-- don't collide.
create unique index space_invitation_token_uq
  on {{schema}}.space_invitation (token)
  where token is not null;

-- The pending-email uniqueness (at most one *active* invite per (space, email))
-- excludes every terminal state and link rows (email null), so re-inviting an
-- email whose prior invite was accepted / revoked / declined is allowed. Replace
-- the old partial index from 007.
drop index if exists {{schema}}.space_invitation_pending_uq;
create unique index space_invitation_pending_uq
  on {{schema}}.space_invitation (space_id, email)
  where email is not null
    and accepted_at is null
    and revoked_at is null
    and declined_at is null;

-------------------------------------------------------------------------------
-- space_invitation_redemption
-- One row per (invitation, redeeming user). Audit + per-user idempotency: an
-- open link can be redeemed by many users but each only joins once. Email
-- invites (single-use) also record their one redemption here.
-------------------------------------------------------------------------------
create table {{schema}}.space_invitation_redemption
( invitation_id uuid        not null references {{schema}}.space_invitation (id) on delete cascade
, user_id       uuid        not null references {{schema}}.principal (id) on delete cascade
, redeemed_at   timestamptz not null default now()
, primary key (invitation_id, user_id)
);
