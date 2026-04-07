import { SQL, semver } from "bun";

export async function bootstrap(sql: SQL): Promise<void> {
  await ensurePrerequisites(sql);
  await ensureRoles(sql);
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
  await ensureExtension(sql, "pg_textsearch", "1.0.0");
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
