alter table {{schema}}.api_key
  drop column if exists last_used_at;
