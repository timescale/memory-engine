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

-- only tables that carry an updated_at column get the trigger
-- (sessions and device_authorization are insert/delete-only and have none)
create or replace trigger users_before_update_trg
before update on {{schema}}.users
for each row
execute function {{schema}}.update_updated_at();

create or replace trigger accounts_before_update_trg
before update on {{schema}}.accounts
for each row
execute function {{schema}}.update_updated_at();

create or replace trigger verifications_before_update_trg
before update on {{schema}}.verifications
for each row
execute function {{schema}}.update_updated_at();
