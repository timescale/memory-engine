-------------------------------------------------------------------------------
-- space_invitation
-- Invitations to a space, keyed by invitee email so an invite can be issued
-- before the user registers. Redeemed at login (against the user's verified
-- email) by redeem_space_invitations, which joins the space (owner@home via
-- add_principal_to_space), optionally grants access at the shared root, and
-- stamps accepted_at. A *pending* invite is one with accepted_at is null;
-- accepted rows are kept as history.
-------------------------------------------------------------------------------
create table {{schema}}.space_invitation
( id           uuid        not null primary key default uuidv7() check (uuid_extract_version(id) = 7)
, space_id     uuid        not null references {{schema}}.space (id) on delete cascade
, email        citext      not null                                    -- invitee (the key; may not be a user yet)
, admin        bool        not null default false                      -- make the user a space admin on redemption
, share_access int                  check (share_access in (1, 2, 3))  -- null = no share grant; else read/write/owner at 'share'
, invited_by   uuid                 references {{schema}}.principal (id) on delete set null -- who issued it (audit)
, created_at   timestamptz not null default now()
, updated_at   timestamptz                                             -- maintained by the before-update trigger
, accepted_at  timestamptz                                             -- null = pending; set on redemption
);

-- at most one pending invite per (space, email); accepted rows are kept as
-- history, so the uniqueness is partial. email is citext, so the dedup is
-- case-insensitive.
create unique index space_invitation_pending_uq
  on {{schema}}.space_invitation (space_id, email)
  where accepted_at is null;
