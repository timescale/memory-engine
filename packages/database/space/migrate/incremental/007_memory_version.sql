
alter table {{schema}}.memory
  add column version bigint not null default 1 check (version > 0)
, add column version_hash text
;

 -- ensure tstzrange renders to text deterministically
set local timezone to 'UTC';
set local datestyle to 'ISO, YMD';

update {{schema}}.memory set
  version_hash = pg_catalog.md5
  (
    pg_catalog.jsonb_build_object
    ( 'tree', tree::text
    , 'name', name
    , 'meta', meta
    , 'temporal', temporal::text
    , 'content', content
    )::text
  )
;

alter table {{schema}}.memory alter column version_hash set not null;
