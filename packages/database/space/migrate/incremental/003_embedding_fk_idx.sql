-- index for finding cascading deletes to queue rows
-- without this index delete_tree on a large number of memories is crazy slow
-- because the cascading deletes have to seq scan the embedding_queue table
create index embedding_queue_memory_id_idx on {{schema}}.embedding_queue (memory_id);
