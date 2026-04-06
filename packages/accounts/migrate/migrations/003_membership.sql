-- ===== Org Member (identity membership in org) =====
create table {{schema}}.org_member
( org_id uuid not null references {{schema}}.org on delete cascade
, identity_id uuid not null references {{schema}}.identity on delete cascade
, role text not null check (role in ('owner', 'admin', 'member'))
, created_at timestamptz not null default now()
, primary key (org_id, identity_id)
);

create index idx_org_member_identity on {{schema}}.org_member (identity_id);
