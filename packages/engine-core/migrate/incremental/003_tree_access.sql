-------------------------------------------------------------------------------
-- tree access
-------------------------------------------------------------------------------
create table {{schema}}.tree_access
( user_id uuid not null references {{schema}}."user"(id) on delete cascade
, tree_path ltree not null
, access int2 not null check (access in (1, 2, 3)) -- read, read/write, owner
, created_at timestamptz not null default now()
, constraint pkey_tree_access primary key (user_id, tree_path)
);

create index idx_tree_access_path on {{schema}}.tree_access using gist (tree_path);
