-- ===== Org Member (user membership in org) =====
create table {{schema}}.org_member
( org_id uuid not null references {{schema}}.org on delete cascade
, user_id uuid not null references {{schema}}."user" on delete cascade
, role text not null check (role in ('owner', 'admin', 'member'))
, created_at timestamptz not null default now()
, primary key (org_id, user_id)
);

create index idx_org_member_user on {{schema}}.org_member (user_id);

-- ===== Engine Access (for users and agents) =====
create table {{schema}}.engine_access
( engine_id uuid not null references {{schema}}.engine on delete cascade
, principal_id uuid not null
, principal_type text not null check (principal_type in ('user', 'agent'))
, role text not null check (role in ('admin', 'member'))
, granted_by uuid references {{schema}}."user"
, created_at timestamptz not null default now()
, primary key (engine_id, principal_id)
);

create index idx_engine_access_principal on {{schema}}.engine_access (principal_id);
create index idx_engine_access_granted_by on {{schema}}.engine_access (granted_by);
