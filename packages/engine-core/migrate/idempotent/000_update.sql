-- generic trigger function to update updated_at timestamp
create or replace function {{schema}}.update_updated_at()
returns trigger
as $func$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$func$ language plpgsql volatile security definer
set search_path to {{schema}}, pg_temp;

create or replace trigger actor_before_update_trg
before update on {{schema}}.actor
for each row
execute function {{schema}}.actor_before_update();

create or replace trigger role_membership_before_update_trg
before update on {{schema}}.role_membership
for each row
execute function {{schema}}.role_membership_before_update();

create or replace trigger tree_access_before_update_trg
before update on {{schema}}.tree_access
for each row
execute function {{schema}}.tree_access_before_update();

create or replace trigger memory_before_update_trg
before update on {{schema}}.memory
for each row
execute function {{schema}}.memory_before_update();

create or replace trigger embedding_queue_before_update_trg
before update on {{schema}}.embedding_queue
for each row
execute function {{schema}}.embedding_queue_before_update();
