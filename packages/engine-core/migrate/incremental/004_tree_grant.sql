-------------------------------------------------------------------------------
-- tree grant
-------------------------------------------------------------------------------
create table {{schema}}.tree_grant
( user_id uuid not null references {{schema}}."user"(id) on delete cascade
, tree_path ltree not null
, actions text[] not null check (actions <@ '{read,create,update,delete}'::text[])
, created_at timestamptz not null default now()
, constraint pkey_tree_grant primary key (user_id, tree_path)
);

create index idx_tree_grant_path on {{schema}}.tree_grant using gist (tree_path);
