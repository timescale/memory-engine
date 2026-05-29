-------------------------------------------------------------------------------
-- space
-------------------------------------------------------------------------------
create table core.space
( id uuid not null primary key default uuidv7() check (uuid_extract_version(id) = 7)
, slug text not null unique check (slug ~ '^[a-z0-9]{12}$')
, name citext not null
, language text not null default 'english' check (language ~ '^[a-z_]+$')
-- we likely need columns for embedding provider, model, dimensions
, created_at timestamptz not null default now()
, updated_at timestamptz
);
