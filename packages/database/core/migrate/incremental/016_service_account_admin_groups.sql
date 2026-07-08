-------------------------------------------------------------------------------
-- service-account admin groups are dedicated one-to-one bindings.
-------------------------------------------------------------------------------

create unique index principal_service_account_admin_id
  on {{schema}}.principal (admin_id) where kind = 's';
