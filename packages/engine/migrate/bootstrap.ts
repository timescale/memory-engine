import { SQL, semver } from "bun";

export async function bootstrap(sql: SQL): Promise<void> {
  await ensurePrerequisites(sql);
  await ensureRoles(sql);
  await ensureEmbeddingSchema(sql);
}

async function ensurePrerequisites(sql: SQL): Promise<void> {
  const [{ server_version_num }] = await sql`
    select current_setting('server_version_num')::int as server_version_num
  `;
  if (server_version_num < 180000) {
    throw new Error(
      `PostgreSQL version 18 or higher is required (found ${server_version_num})`,
    );
  }

  await ensureExtension(sql, "citext", "1.6");
  await ensureExtension(sql, "ltree", "1.3");
  await ensureExtension(sql, "vector", "0.8.2");
  await ensureExtension(sql, "pg_textsearch", "0.6.1");
}

async function ensureExtension(
  sql: SQL,
  name: string,
  minVersion: string,
): Promise<void> {
  const [installed] = await sql`
    select extversion from pg_extension where extname = ${name}
  `;

  if (installed) {
    if (semver.order(installed.extversion, minVersion) >= 0) {
      return;
    }
    throw new Error(
      `Extension "${name}" version ${minVersion} or higher is required (found ${installed.extversion} installed)`,
    );
  }

  const [available] = await sql`
    select default_version
    from pg_available_extensions
    where name = ${name}
  `;

  if (!available || semver.order(available.default_version, minVersion) < 0) {
    const found = available
      ? `found ${available.default_version} available`
      : "not available";
    throw new Error(
      `Extension "${name}" version ${minVersion} or higher is required (${found})`,
    );
  }

  try {
    await sql`create extension if not exists ${sql(name)}`;
  } catch (error: unknown) {
    // Ignore duplicate extension errors (race condition in concurrent calls)
    if (
      error instanceof SQL.PostgresError &&
      error.errno === "23505" &&
      error.constraint === "pg_extension_name_index"
    ) {
      return;
    }
    throw error;
  }
}

async function ensureRoles(sql: SQL): Promise<void> {
  await sql.unsafe(`
    do $block$
    declare
      _roles text[] = array['me_ro', 'me_rw', 'me_embed'];
      _role text;
      _sql text;
    begin
      for _role in select * from unnest(_roles) loop
        perform
        from pg_roles r
        where r.rolname = _role;
        if found then
          continue;
        end if;
        _sql = format($sql$create role %I nologin$sql$, _role);
        execute _sql;
        _sql = format($sql$grant %I to %I$sql$, _role, current_user);
        execute _sql;
      end loop;
    end;
    $block$;
  `);
}

async function ensureEmbeddingSchema(sql: SQL): Promise<void> {
  await sql.unsafe(`create schema if not exists embedding`);

  await sql.unsafe(`
    create table if not exists embedding.queue
    ( id                bigint generated always as identity primary key
    , schema_name       text not null
    , memory_id         uuid not null
    , embedding_version int not null
    , vt                timestamptz not null default now()
    , outcome           text check (outcome is null or outcome in ('completed', 'failed', 'cancelled'))
    , attempts          int not null default 0
    , max_attempts      int not null default 3
    , last_error        text
    , created_at        timestamptz not null default now()
    )
  `);

  await sql.unsafe(`
    create table if not exists embedding.queue_hist
    ( id                bigint primary key
    , schema_name       text not null
    , memory_id         uuid not null
    , embedding_version int not null
    , vt                timestamptz not null
    , outcome           text
    , attempts          int not null
    , max_attempts      int not null
    , last_error        text
    , created_at        timestamptz not null
    )
  `);

  await sql.unsafe(`
    create index if not exists embedding_queue_claim_idx
      on embedding.queue (vt)
      where outcome is null;

    create index if not exists embedding_queue_memory_idx
      on embedding.queue (schema_name, memory_id, embedding_version desc)
      where outcome is null;

    create index if not exists embedding_queue_archive_idx
      on embedding.queue (created_at)
      where outcome is not null;
  `);

  // claim_batch stub function
  await sql.unsafe(`
    create or replace function embedding.claim_batch(
      p_batch_size int default 10,
      p_visibility_timeout interval default '30 seconds'
    )
    returns table (
      id bigint,
      schema_name text,
      memory_id uuid,
      embedding_version int,
      attempts int
    )
    language plpgsql
    security definer
    set search_path to pg_catalog, embedding, pg_temp
    as $func$
    begin
      -- stub: will be replaced by worker package with full implementation
      return query
        with claimed as (
          select q.id
          from embedding.queue q
          where q.outcome is null
            and q.vt <= now()
            and q.attempts < q.max_attempts
          order by q.vt
          limit p_batch_size
          for update skip locked
        )
        update embedding.queue q
        set vt = now() + p_visibility_timeout,
            attempts = q.attempts + 1
        from claimed c
        where q.id = c.id
        returning q.id, q.schema_name, q.memory_id, q.embedding_version, q.attempts;
    end;
    $func$;
  `);

  // Shared trigger function — each engine's triggers pass their schema name as TG_ARGV[0]
  await sql.unsafe(`
    create or replace function embedding.enqueue_embedding()
    returns trigger
    language plpgsql volatile security definer
    set search_path to pg_catalog, embedding, pg_temp
    as $func$
    begin
      insert into embedding.queue (schema_name, memory_id, embedding_version)
      values (TG_ARGV[0], new.id, new.embedding_version);
      return new;
    end;
    $func$;
  `);

  // Grants — only me_embed needs access; enqueue_embedding() is security definer
  await sql.unsafe(`
    grant usage on schema embedding to me_embed;
    grant select, update on embedding.queue to me_embed;
    grant execute on function embedding.claim_batch(int, interval) to me_embed;
  `);
}
