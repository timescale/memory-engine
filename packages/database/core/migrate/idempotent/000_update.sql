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

create or replace trigger space_before_update_trg
before update on {{schema}}.space
for each row
execute function {{schema}}.update_updated_at();

create or replace trigger principal_before_update_trg
before update on {{schema}}.principal
for each row
execute function {{schema}}.update_updated_at();

create or replace trigger principal_space_before_update_trg
before update on {{schema}}.principal_space
for each row
execute function {{schema}}.update_updated_at();

create or replace trigger group_member_before_update_trg
before update on {{schema}}.group_member
for each row
execute function {{schema}}.update_updated_at();

create or replace trigger tree_access_before_update_trg
before update on {{schema}}.tree_access
for each row
execute function {{schema}}.update_updated_at();

create or replace trigger space_invitation_before_update_trg
before update on {{schema}}.space_invitation
for each row
execute function {{schema}}.update_updated_at();
