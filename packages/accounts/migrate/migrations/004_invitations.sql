-- ===== Invitation (pending org invitations) =====
create table {{schema}}.invitation
( id uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, org_id uuid not null references {{schema}}.org on delete cascade
, email citext not null
, role text not null check (role in ('owner', 'admin', 'member'))
, token text unique not null
, invited_by uuid not null references {{schema}}.identity
, expires_at timestamptz not null
, accepted_at timestamptz
, created_at timestamptz not null default now()
, unique (org_id, email)
);

create index idx_invitation_token on {{schema}}.invitation (token) where accepted_at is null;
create index idx_invitation_org on {{schema}}.invitation (org_id) where accepted_at is null;
create index idx_invitation_email on {{schema}}.invitation (email) where accepted_at is null;
