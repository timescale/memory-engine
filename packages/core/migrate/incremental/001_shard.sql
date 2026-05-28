-------------------------------------------------------------------------------
-- shard
-------------------------------------------------------------------------------
create table core.shard
( id int primary key
);

-- seed default shard
insert into core.shard (id) values (1);
