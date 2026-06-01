-------------------------------------------------------------------------------
-- group_member
-------------------------------------------------------------------------------
create table {{schema}}.group_member
( space_id uuid not null references {{schema}}.space (id) on delete cascade
, group_id uuid not null references {{schema}}.principal (group_id) on delete cascade -- can only be groups
, member_id uuid not null references {{schema}}.principal (member_id) on delete cascade -- can be users or agents, but not groups
, admin bool not null default false
, created_at timestamptz not null default now()
, updated_at timestamptz
, unique (space_id, member_id, group_id) include (admin)
);

-- index for listing groups in a space and/or members of a group
create index on {{schema}}.group_member (space_id, group_id, member_id) include (admin);
