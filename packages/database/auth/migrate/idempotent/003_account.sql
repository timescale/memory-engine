-------------------------------------------------------------------------------
-- upsert_account
-- Links an OAuth provider account to a user. Login-only: no tokens stored, and
-- no email (the verified email lives on users.email — better-auth-shaped).
-- The (provider_id, account_id) pair is the stable identity key.
-------------------------------------------------------------------------------
create or replace function {{schema}}.upsert_account
( _user_id uuid
, _provider_id text
, _account_id text
)
returns uuid
as $func$
  insert into {{schema}}.accounts (user_id, provider_id, account_id)
  values (_user_id, _provider_id, _account_id)
  on conflict (provider_id, account_id) do update set
    user_id = excluded.user_id -- updated_at maintained by the before-update trigger
  returning id
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- get_account_by_provider
-- The login lookup: resolves the owning user from the provider account id.
-- Resolving by (provider_id, account_id) — NOT by email — is what prevents
-- account-takeover via a different provider asserting the same address.
-------------------------------------------------------------------------------
create or replace function {{schema}}.get_account_by_provider
( _provider_id text
, _account_id text
)
returns table
( id uuid
, user_id uuid
, provider_id text
, account_id text
)
as $func$
  select a.id, a.user_id, a.provider_id, a.account_id
  from {{schema}}.accounts a
  where a.provider_id = _provider_id
    and a.account_id = _account_id
$func$ language sql stable strict rows 1 security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- get_accounts_by_user
-------------------------------------------------------------------------------
create or replace function {{schema}}.get_accounts_by_user(_user_id uuid)
returns table
( id uuid
, user_id uuid
, provider_id text
, account_id text
)
as $func$
  select a.id, a.user_id, a.provider_id, a.account_id
  from {{schema}}.accounts a
  where a.user_id = _user_id
  order by a.created_at
$func$ language sql stable strict security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;

-------------------------------------------------------------------------------
-- unlink_account
-------------------------------------------------------------------------------
create or replace function {{schema}}.unlink_account(_id uuid)
returns bool
as $func$
  with d as
  (
    delete from {{schema}}.accounts where id = _id returning 1
  )
  select exists (select 1 from d)
$func$ language sql volatile security invoker
set search_path to pg_catalog, {{schema}}, public, pg_temp
;
