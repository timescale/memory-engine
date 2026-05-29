create schema core;

create table core.version
( version text not null
, at timestamptz not null default now()
);

create unique index version_singleton_idx on core.version ((true)); -- only ONE row allowed
insert into core.version (version) values ('0.0.0');

create table core.migration
( name text not null constraint migration_pkey primary key
, applied_at_version text not null
, applied_at timestamptz not null default pg_catalog.clock_timestamp()
);
