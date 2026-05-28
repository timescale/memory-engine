-------------------------------------------------------------------------------
-- role membership
-------------------------------------------------------------------------------
-- a member who has "tree-admin" can add and remove members from the role
create table {{schema}}.role_membership
( role_id   uuid not null references {{schema}}.actor (role_id) on delete cascade
, member_id uuid not null references {{schema}}.actor (role_member_id) on delete cascade
, admin boolean not null default false
, created_at timestamptz not null default now()
, updated_at timestamptz
, constraint pkey_role_membership primary key (member_id, role_id)
, constraint no_self_membership check (role_id != member_id)
);

create index idx_role_membership_role on {{schema}}.role_membership(role_id) include (member_id);

-- built-in role membership
insert into {{schema}}.role_membership
( role_id
, member_id
, admin
)
values
  ('00584580-f000-7000-8000-000000000001', '00584580-f000-7000-8000-000000000003', true) -- owner belongs to user-admin
, ('00584580-f000-7000-8000-000000000002', '00584580-f000-7000-8000-000000000003', true) -- owner belongs to tree-admin
;
