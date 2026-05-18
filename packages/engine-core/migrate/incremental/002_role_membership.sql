-------------------------------------------------------------------------------
-- role membership
-------------------------------------------------------------------------------
create table {{schema}}.role_membership
( role_id   uuid not null references {{schema}}."user"(id) on delete cascade
, member_id uuid not null references {{schema}}."user"(id) on delete cascade
, with_admin_option boolean not null default false
, created_at timestamptz not null default now()
, constraint pkey_role_membership primary key (member_id, role_id)
, constraint no_self_membership check (role_id != member_id)
);

create index idx_role_membership_role on {{schema}}.role_membership(role_id) include (member_id);
