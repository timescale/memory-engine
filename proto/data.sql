

-------------------------------------------------------------------------------
-- testing data
-------------------------------------------------------------------------------
begin;

insert into me."user" (id, name, superuser)
values
  ('019e2833-f217-7457-ba8b-f110393b6d1c', 'user_0', true)
, ('019e2833-f217-74a0-84ca-49e9655ed2e2', 'user_1', true)
, ('019e2833-f217-74a9-9860-fde559ebc44f', 'user_2', false)
, ('019e2833-f217-74af-b5f5-c0cd0beb78ab', 'user_3', false)
, ('019e2833-f217-74b6-97f5-bad28152696d', 'user_4', false)
, ('019e2833-f217-74bc-9ae6-54f009c08d3e', 'user_5', false)
, ('019e2833-f217-74c2-a612-9ccc17e11380', 'user_6', false)
, ('019e2833-f217-74c8-8eab-bcfcedc95d29', 'user_7', false)
, ('019e2833-f217-74ce-8820-6ea10aebd123', 'user_8', false)
, ('019e2833-f217-74d5-b22f-0091833bf484', 'user_9', false)
;

insert into me."user" (id, name, superuser)
values
  ('019e2835-3ece-7cbc-a450-4abb1d3437c2','role_0',      true )
, ('019e2835-3ece-7d03-91bb-61c94fa959a5','role_0.1',    false)
, ('019e2835-3ece-7d0b-bf85-7b8707750774','role_1',      false)
, ('019e2835-3ece-7d11-aaa5-24414460784f','role_1.1',    false)
, ('019e2835-3ece-7d17-8d9d-7291258c8d0b','role_1.2',    false)
, ('019e2835-3ece-7d1e-9acd-b4597611d70c','role_1.2.1',  false)
;

-- roles to roles
select me.grant_role_membership('019e2835-3ece-7cbc-a450-4abb1d3437c2', '019e2835-3ece-7d03-91bb-61c94fa959a5');
select me.grant_role_membership('019e2835-3ece-7d0b-bf85-7b8707750774', '019e2835-3ece-7d11-aaa5-24414460784f');
select me.grant_role_membership('019e2835-3ece-7d0b-bf85-7b8707750774', '019e2835-3ece-7d17-8d9d-7291258c8d0b');
select me.grant_role_membership('019e2835-3ece-7d17-8d9d-7291258c8d0b', '019e2835-3ece-7d1e-9acd-b4597611d70c');

-- add users to roles
select me.grant_role_membership('019e2835-3ece-7cbc-a450-4abb1d3437c2', '019e2833-f217-74a9-9860-fde559ebc44f');
select me.grant_role_membership('019e2835-3ece-7d03-91bb-61c94fa959a5', '019e2833-f217-74af-b5f5-c0cd0beb78ab');
select me.grant_role_membership('019e2835-3ece-7d0b-bf85-7b8707750774', '019e2833-f217-74b6-97f5-bad28152696d');
select me.grant_role_membership('019e2835-3ece-7d11-aaa5-24414460784f', '019e2833-f217-74bc-9ae6-54f009c08d3e');
select me.grant_role_membership('019e2835-3ece-7d17-8d9d-7291258c8d0b', '019e2833-f217-74c2-a612-9ccc17e11380');
select me.grant_role_membership('019e2835-3ece-7d1e-9acd-b4597611d70c', '019e2833-f217-74c8-8eab-bcfcedc95d29');
select me.grant_role_membership('019e2835-3ece-7d1e-9acd-b4597611d70c', '019e2833-f217-74ce-8820-6ea10aebd123');
select me.grant_role_membership('019e2835-3ece-7d1e-9acd-b4597611d70c', '019e2833-f217-74d5-b22f-0091833bf484');
commit;
