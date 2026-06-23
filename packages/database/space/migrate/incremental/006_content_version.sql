
alter table {{schema}}.memory rename column embedding_version to content_version;

alter table {{schema}}.embedding_queue rename column embedding_version to content_version;
