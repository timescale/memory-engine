-------------------------------------------------------------------------------
-- scoped api keys
--
-- Existing keys remain unrestricted. Restricted keys carry one or more
-- per-space declarations; tree rows are optional because no rows means the
-- declaration permits the holder's full live tree access in that space.
-------------------------------------------------------------------------------

alter table {{schema}}.api_key
add column restricted boolean not null default false;

create table {{schema}}.api_key_space_access
( api_key_id   uuid    not null references {{schema}}.api_key (id) on delete cascade
, space_id     uuid    not null references {{schema}}.space (id) on delete cascade
, space_admin  boolean not null default false
, primary key (api_key_id, space_id)
);

create table {{schema}}.api_key_tree_access
( api_key_id   uuid  not null
, space_id     uuid  not null
, tree_path    ltree not null
, access       int   not null check (access in (1, 2, 3)) -- read, write, owner
, primary key (api_key_id, space_id, tree_path)
, foreign key (api_key_id, space_id)
    references {{schema}}.api_key_space_access (api_key_id, space_id)
    on delete cascade
);
