-- Session and invitation tokens are stored as their sha256 digest in
-- token_hash, used as a unique-indexed lookup key. Raw tokens are 256-bit
-- CSPRNG output, so sha256 alone provides preimage resistance equivalent
-- to argon2 against an offline DB dump — without paying ~60ms per verify
-- and without the O(n) scan-and-verify pattern the previous schema forced.

-- Drop existing rows: we don't store raw tokens, so we cannot derive
-- token_hash for them. All current CLI sessions become invalid (next
-- command yields a 401, "Invalid or expired session"; user runs `me login`).
-- All pending invitations must be re-issued.
truncate {{schema}}.session;
truncate {{schema}}.invitation;

-- `drop column` cascades to dependent indexes and constraints. This removes
-- session_token_key (unique constraint) and idx_session_token, plus
-- invitation_token_key (unique constraint) and idx_invitation_token.
alter table {{schema}}.session   drop column token;
alter table {{schema}}.invitation drop column token;

alter table {{schema}}.session
    add column token_hash bytea not null;
alter table {{schema}}.invitation
    add column token_hash bytea not null;

create unique index session_token_hash_uniq
    on {{schema}}.session (token_hash);

create unique index invitation_token_hash_uniq
    on {{schema}}.invitation (token_hash)
    where accepted_at is null;
