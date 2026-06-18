-- we want to add new optional parameters to these functions
-- changing the signature == creating a new function because pg supports function overloading
-- we have to drop the old versions that we no longer want

drop function if exists {{schema}}.count_tree
( jsonb
, ltree
, int4
);

drop function if exists {{schema}}.count_tree
( jsonb
, lquery
, int4
);

drop function if exists {{schema}}.count_tree
( jsonb
, ltxtquery
, int4
);
