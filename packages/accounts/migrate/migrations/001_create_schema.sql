-- Bootstrap migration: creates the accounts schema and infrastructure tables
create schema if not exists {{schema}};

-- Version tracking table (single row, tracks overall schema version)
create table {{schema}}.version
( version text not null check (version ~ '^\d+\.\d+\.\d+$')
, at timestamptz not null default now()
);
create unique index on {{schema}}.version ((true));
insert into {{schema}}.version (version) values ('0.0.0');

-- Migration tracking table
create table {{schema}}.migration
( name text not null primary key
, applied_at_version text not null
, applied_at timestamptz not null default pg_catalog.clock_timestamp()
);
