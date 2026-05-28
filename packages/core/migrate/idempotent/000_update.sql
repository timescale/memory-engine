-- generic trigger function to update updated_at timestamp
create or replace function core.update_updated_at()
returns trigger
as $func$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$func$ language plpgsql volatile security definer
set search_path to core, pg_temp;

create or replace trigger space_before_update_trg
before update on core.space
for each row
execute function core.update_updated_at();

create or replace trigger principal_before_update_trg
before update on core.principal
for each row
execute function core.update_updated_at();

create or replace trigger principal_space_before_update_trg
before update on core.principal_space
for each row
execute function core.update_updated_at();

create or replace trigger group_member_before_update_trg
before update on core.group_member
for each row
execute function core.update_updated_at();

create or replace trigger tree_access_before_update_trg
before update on core.tree_access
for each row
execute function core.update_updated_at();
