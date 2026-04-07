-- Encryption keys for envelope encryption
create table {{schema}}.encryption_key
( id int primary key generated always as identity
, key_ciphertext bytea not null
, active boolean not null default false
, created_at timestamptz not null default now()
);

-- Only one active key at a time
create unique index idx_encryption_key_active
  on {{schema}}.encryption_key (active) where active = true;

-- Track which key encrypted OAuth tokens
alter table {{schema}}.oauth_account
  add column encryption_key_id int references {{schema}}.encryption_key(id);

-- Trigger to prevent removing the last owner from an org
create function {{schema}}.check_org_has_owner()
returns trigger as $func$
begin
  if (TG_OP = 'DELETE' and OLD.role = 'owner')
     or (TG_OP = 'UPDATE' and OLD.role = 'owner' and NEW.role <> 'owner')
  then
    if not exists (
      select 1 from {{schema}}.org_member
      where org_id = OLD.org_id
        and role = 'owner'
        and identity_id <> OLD.identity_id
    ) then
      raise exception 'org_must_have_owner'
        using errcode = 'P0001',
              hint = 'Cannot remove the last owner from an organization';
    end if;
  end if;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$func$ language plpgsql;

create trigger org_member_owner_check
  before delete or update on {{schema}}.org_member
  for each row
  execute function {{schema}}.check_org_has_owner();
