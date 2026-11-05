-- Require consent for the seeded CLI client on new and existing databases.
update {{schema}}.oauth_client
set skip_consent = false
where client_id = 'me-cli';
