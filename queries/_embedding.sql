-- Semantic query helper. If emb is not already supplied, generate it outside
-- the timed block using scripts/embed-query.ts and then load the file into emb.
-- Optional variables: semantic, emb_file. Default emb_file: queries/emb.txt.

\if :{?emb}
\else
\if :{?emb_file}
\else
\set emb_file queries/emb.txt
\endif
\echo Generating embedding outside timed block...
\if :{?semantic}
\! ./bun run scripts/embed-query.ts :emb_file :'semantic'
\else
\! ./bun run scripts/embed-query.ts :emb_file
\endif
\set emb `cat :emb_file`
\endif
