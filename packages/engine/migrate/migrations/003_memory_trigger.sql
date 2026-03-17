-- before-update trigger for memory table
create function {{schema}}.memory_before_update()
returns trigger
as $func$
begin
  -- always update the timestamp
  new.updated_at = pg_catalog.now();

  -- content changed -> new embedding needs to be generated
  if old.content is distinct from new.content
     and old.embedding is not distinct from new.embedding
  then
    new.embedding = null;
    new.embedding_attempts = 0;
    new.embedding_version = old.embedding_version operator(pg_catalog.+) 1;
    new.embedding_last_error = null;
  end if;

  -- likely the embedding engine setting the embedding
  if new.embedding is not null then
    new.embedding_attempts = 0;
    new.embedding_last_error = null;
  end if;

  return new;
end;
$func$ language plpgsql volatile security definer
set search_path to {{schema}}, public, pg_temp; -- public required for pgvector's `is not distinct from`

create trigger memory_before_update_trg
before update on {{schema}}.memory
for each row
execute function {{schema}}.memory_before_update();

-- enqueue embedding work via the shared embedding.enqueue_embedding()
create trigger memory_enqueue_embedding_insert
  after insert on {{schema}}.memory
  for each row
  when (new.embedding is null)
  execute function embedding.enqueue_embedding('{{schema}}');

create trigger memory_enqueue_embedding_update
  after update on {{schema}}.memory
  for each row
  when (old.content is distinct from new.content
    and new.embedding is null
    and new.embedding_attempts < 3)
  execute function embedding.enqueue_embedding('{{schema}}');

-- embedding worker needs access to this engine's memory table
grant usage on schema {{schema}} to me_embed;
grant select, update on {{schema}}.memory to me_embed;
