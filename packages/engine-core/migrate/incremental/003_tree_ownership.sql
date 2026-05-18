-------------------------------------------------------------------------------
-- tree ownership
-------------------------------------------------------------------------------
create table {{schema}}.tree_owner
( tree_path ltree not null primary key
, user_id uuid not null references {{schema}}."user" (id) on delete cascade
, created_at timestamptz not null default now()
);

create index idx_tree_owner_user on {{schema}}.tree_owner (user_id);
create index idx_tree_owner_gist on {{schema}}.tree_owner using gist (tree_path);
