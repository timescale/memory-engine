-------------------------------------------------------------------------------
-- tree_access
-------------------------------------------------------------------------------
create table core.tree_access
( space_id uuid not null references core.space (id) on delete cascade
, principal_id uuid not null references core.principal (id) on delete cascade -- can be users, agents, or groups
, tree_path ltree not null
, access int not null check (access in (1, 2, 3)) -- 1 = read, 2 = write, 3 = owner
, created_at timestamptz not null default now()
, updated_at timestamptz
, unique (principal_id, space_id, tree_path) include (access)
);

-- list access per space or per space and principal
create index on core.tree_access (space_id, principal_id);
