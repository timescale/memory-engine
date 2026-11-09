-------------------------------------------------------------------------------
-- Principal suspension: reversible lockout for user and service-account
-- principals.
--
-- Incrementals run before idempotents, so drop every function whose return
-- table gains a suspension column before the living idempotents recreate them.
-------------------------------------------------------------------------------
drop function if exists {{schema}}.get_principal(uuid);
drop function if exists {{schema}}.get_user_by_name(text);
drop function if exists {{schema}}.validate_api_key(text, text);

alter table {{schema}}.principal
  add column suspended_at timestamptz
, add constraint principal_suspended_kind_check check
  (
    kind in ('u', 's')
    or suspended_at is null
  )
;
