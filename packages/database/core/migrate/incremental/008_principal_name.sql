-- principal names for users come from their OAuth emails
-- the only additional constraint on user names is the existing check that rejects forward slashes
-- we want agent and group names to be even more restrictive
-- this check constraint implements the additional restriction
alter table {{schema}}.principal add constraint principal_agent_group_name_check check
(
  kind not in ('a', 'g')
  or name::text ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
);
