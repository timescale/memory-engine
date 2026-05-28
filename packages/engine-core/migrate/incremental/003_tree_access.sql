-------------------------------------------------------------------------------
-- tree access
-------------------------------------------------------------------------------
-- access applies to the path AND below
-- 1 = read, 2 = write, 3 = owner
-- write includes read
-- owner includes read and write + grant to others
-- tree owners can grant/revoke access to the tree (and below)
create table {{schema}}.tree_access
( actor_id uuid not null references {{schema}}.actor (id) on delete cascade
, tree_path ltree not null
, access int not null check (access in (1, 2, 3)) -- read, write, owner
, created_at timestamptz not null default now()
, updated_at timestamptz
, constraint pkey_tree_access primary key (actor_id, tree_path)
);

create index idx_tree_access_path on {{schema}}.tree_access using gist (tree_path);

-- by default, the owner owns the entire tree
insert into {{schema}}.tree_access
( actor_id
, tree_path
, access
)
values
( '00584580-f000-7000-8000-000000000003'
, ''::ltree
, 3
);
