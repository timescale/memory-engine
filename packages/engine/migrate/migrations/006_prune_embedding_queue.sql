-- prune terminal queue rows older than the retention window.
-- runs opportunistically from the worker on engines that returned no
-- claimable work, so the queue table doesn't grow unbounded.
--
-- relies on embedding_queue_archive_idx (created_at) where outcome is not null
-- from migration 005, so the no-op case is cheap.
create or replace function {{schema}}.prune_embedding_queue
( retention interval default '7 days'
)
returns bigint
language plpgsql volatile
set search_path to pg_catalog, {{schema}}, pg_temp
as $func$
declare
  pruned bigint;
begin
  delete from {{schema}}.embedding_queue
  where outcome is not null
    and created_at < now() - retention;
  get diagnostics pruned = row_count;
  return pruned;
end;
$func$;

-- me_embed already has DELETE on embedding_queue (granted in 005);
-- this just exposes the function entrypoint.
grant execute on function {{schema}}.prune_embedding_queue(interval) to me_embed;
