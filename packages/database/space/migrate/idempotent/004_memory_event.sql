-------------------------------------------------------------------------------
-- memory_event_context
-------------------------------------------------------------------------------
create or replace function {{schema}}.memory_event_context()
returns jsonb
as $func$
declare
  _event_context jsonb;
begin
  _event_context = coalesce(nullif(current_setting('me.event_context', true), '')::jsonb, '{}'::jsonb);
  if not (_event_context ? 'operation_id') then
    _event_context = jsonb_set(_event_context, '{operation_id}', to_jsonb(uuidv7()));
    perform set_config('me.event_context', _event_context::text, true);
  end if;
  return _event_context;
end
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- memory_log_event
-------------------------------------------------------------------------------
create or replace function {{schema}}.memory_log_event()
returns trigger
as $func$
declare
  _event_context jsonb;
begin
  if tg_op = 'INSERT'
     or tg_op = 'DELETE'
     or row(old.tree, old.temporal, old.name, old.meta, old.content)
        is distinct from
        row(new.tree, new.temporal, new.name, new.meta, new.content)
  then
    _event_context = {{schema}}.memory_event_context();
    insert into {{schema}}.memory_event
    ( memory_id
    , operation
    , operation_id
    , cause
    , actor
    , tree
    , name
    , meta
    , temporal
    , content
    , content_version
    , version
    , version_hash
    )
    values
    ( case when tg_op = 'DELETE' then old.id else new.id end
    , lower(tg_op)
    , (_event_context->>'operation_id')::uuid
    , _event_context->>'cause'
    , _event_context - 'cause' - 'operation_id'
    , case when tg_op = 'DELETE' then old.tree else new.tree end
    , case when tg_op = 'DELETE' then old.name else new.name end
    , case when tg_op = 'DELETE' then old.meta else new.meta end
    , case when tg_op = 'DELETE' then old.temporal else new.temporal end
    , case when tg_op = 'DELETE' then old.content else new.content end
    , case when tg_op = 'DELETE' then old.content_version else new.content_version end
    , case when tg_op = 'DELETE' then old.version else new.version end
    , case when tg_op = 'DELETE' then old.version_hash else new.version_hash end
    );

  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

create or replace trigger memory_log_event_trg
after insert or update or delete on {{schema}}.memory
for each row execute function {{schema}}.memory_log_event();
