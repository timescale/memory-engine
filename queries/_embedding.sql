-- Semantic query helper. If emb is not already supplied, generate it outside
-- the timed block using scripts/embed-query.ts and then load the file into emb.
-- Optional variable: semantic. Fixed helper files: queries/semantic.txt, queries/emb.txt.
-- Note: psql does not expand variables in \! shell commands, so keep these
-- paths literal unless you also update the shell commands below.

\if :{?emb}
\else
\echo Generating embedding outside timed block...
\if :{?semantic}
select :'semantic'::text
\g (format=unaligned tuples_only=on) queries/semantic.txt
\! ./bun run scripts/embed-query.ts queries/emb.txt --query-file queries/semantic.txt
\else
\! ./bun run scripts/embed-query.ts queries/emb.txt
\endif
\set emb `cat queries/emb.txt`
\endif
