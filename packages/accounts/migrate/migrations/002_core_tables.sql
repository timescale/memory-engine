-- ===== Shard (minimal, for future scaling) =====
create table {{schema}}.shard
( id int primary key
);

-- seed default shard
insert into {{schema}}.shard (id) values (1);

-- ===== Org (billing/ownership entity) =====
create table {{schema}}.org
( id uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, slug text unique not null check (slug ~ '^[a-z0-9]{12}$')
, name text not null
, created_at timestamptz not null default now()
, updated_at timestamptz
);

create trigger org_updated_at
    before update on {{schema}}.org
    for each row
    execute function {{schema}}.update_updated_at();

-- ===== Identity (human who can log in) =====
create table {{schema}}.identity
( id uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, email citext unique not null
, name text not null
, created_at timestamptz not null default now()
, updated_at timestamptz
);

create trigger identity_updated_at
    before update on {{schema}}.identity
    for each row
    execute function {{schema}}.update_updated_at();

-- ===== Engine (memory engine instance) =====
create table {{schema}}.engine
( id uuid primary key default uuidv7() check (uuid_extract_version(id) = 7)
, org_id uuid not null references {{schema}}.org on delete cascade
, slug text unique not null check (slug ~ '^[a-z0-9]{12}$')
, name text not null
, shard_id int not null references {{schema}}.shard
, status text not null default 'active' check (status in ('active', 'suspended', 'deleted'))
, language text not null default 'english' check (language ~ '^[a-z_]+$')
, created_at timestamptz not null default now()
, updated_at timestamptz
, unique (org_id, name)
);

create index idx_engine_org on {{schema}}.engine (org_id);
create index idx_engine_shard on {{schema}}.engine (shard_id);
create index idx_engine_status on {{schema}}.engine (status) where status <> 'active';

create trigger engine_updated_at
    before update on {{schema}}.engine
    for each row
    execute function {{schema}}.update_updated_at();
