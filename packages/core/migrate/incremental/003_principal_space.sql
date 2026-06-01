-------------------------------------------------------------------------------
-- principal_space
-------------------------------------------------------------------------------
create table {{schema}}.principal_space
( space_id uuid not null references {{schema}}.space (id) on delete cascade
, principal_id uuid not null references {{schema}}.principal (id) on delete cascade -- can be users, agents, or groups
, admin bool not null default false
, created_at timestamptz not null default now()
, updated_at timestamptz
, unique (principal_id, space_id) include (admin)
);

create index on {{schema}}.principal_space (space_id, principal_id) include (admin);
