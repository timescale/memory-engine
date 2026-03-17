import { SQL } from "bun";

function assertSafeIdentifier(name: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe database identifier: ${name}`);
  }
}

export class TestDatabase {
  private dbName: string | null = null;
  private readonly adminUrl: string;

  constructor(adminUrl = "postgresql://postgres@localhost:5432/postgres") {
    this.adminUrl = adminUrl;
  }

  async create(): Promise<string> {
    this.dbName = `test_me_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    assertSafeIdentifier(this.dbName);
    const sql = new SQL(this.adminUrl);
    try {
      await sql.unsafe(`create database ${this.dbName}`);
    } finally {
      await sql.close();
    }

    const url = new URL(this.adminUrl);
    url.pathname = `/${this.dbName}`;
    return url.toString();
  }

  async drop(): Promise<void> {
    if (!this.dbName) {
      return;
    }

    assertSafeIdentifier(this.dbName);
    const sql = new SQL(this.adminUrl);
    try {
      await sql`
        select pg_terminate_backend(pg_stat_activity.pid)
        from pg_stat_activity
        where pg_stat_activity.datname = ${this.dbName}
          and pid <> pg_backend_pid()
      `;

      await sql.unsafe(`drop database if exists ${this.dbName}`);
    } finally {
      await sql.close();
      this.dbName = null;
    }
  }
}

export async function getAppliedMigrations(
  sql: SQL,
  schema: string,
): Promise<string[]> {
  const rows = await sql.unsafe(
    `select name from ${schema}.migration order by name`,
  );
  return rows.map((r: { name: string }) => r.name);
}

export async function tableExists(
  sql: SQL,
  schema: string,
  table: string,
): Promise<boolean> {
  const [row] = await sql`
    select exists (
      select 1
      from information_schema.tables
      where table_schema = ${schema}
        and table_name = ${table}
    ) as exists
  `;
  return row.exists;
}

export async function schemaExists(sql: SQL, name: string): Promise<boolean> {
  const [row] = await sql`
    select exists (
      select 1
      from information_schema.schemata
      where schema_name = ${name}
    ) as exists
  `;
  return row.exists;
}

export async function countMigrations(
  sql: SQL,
  schema: string,
): Promise<number> {
  const [row] = await sql.unsafe(
    `select count(*)::int as count from ${schema}.migration`,
  );
  return row.count;
}

export async function getTableColumns(
  sql: SQL,
  schema: string,
  table: string,
): Promise<
  Array<{ column_name: string; data_type: string; is_nullable: string }>
> {
  return await sql`
    select column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = ${schema}
      and table_name = ${table}
    order by ordinal_position
  `;
}

export async function getIndexes(
  sql: SQL,
  schema: string,
  table: string,
): Promise<string[]> {
  const rows = await sql`
    select indexname
    from pg_indexes
    where schemaname = ${schema}
      and tablename = ${table}
    order by indexname
  `;
  return rows.map((r: { indexname: string }) => r.indexname);
}

export async function getRoles(
  sql: SQL,
  ...names: string[]
): Promise<Array<{ rolname: string; rolcanlogin: boolean }>> {
  const pgArray = `{${names.join(",")}}`;
  return await sql.unsafe(
    `select rolname, rolcanlogin
     from pg_roles
     where rolname = any($1::text[])
     order by rolname`,
    [pgArray],
  );
}

export async function getFunctions(
  sql: SQL,
  schema: string,
): Promise<Array<{ proname: string; proconfig: string[] | null }>> {
  return await sql`
    select p.proname, p.proconfig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = ${schema}
    order by p.proname
  `;
}
