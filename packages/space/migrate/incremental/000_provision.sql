create schema {{schema}};

create table {{schema}}.version
( version text not null
, at timestamptz not null default now()
);

create unique index version_singleton_idx on {{schema}}.version ((true)); -- only ONE row allowed
insert into {{schema}}.version (version) values ('0.0.0');

create table {{schema}}.migration
( name text not null constraint migration_pkey primary key
, applied_at_version text not null
, applied_at timestamptz not null default pg_catalog.clock_timestamp()
);
