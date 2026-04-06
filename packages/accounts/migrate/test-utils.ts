import { SQL } from "bun";
import { migrate } from "./runner";
import type { AccountsConfig } from "./template";

function assertSafeIdentifier(name: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe database identifier: ${name}`);
  }
}

export class TestDatabase {
  schema: string;
  sql: SQL;
  private readonly adminUrl: string;

  private constructor(schema: string, sql: SQL, adminUrl: string) {
    this.schema = schema;
    this.sql = sql;
    this.adminUrl = adminUrl;
  }

  static async create(
    adminUrl = "postgresql://postgres@localhost:5432/postgres",
    appVersion = "0.1.0",
  ): Promise<TestDatabase> {
    const schema = `accounts_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    assertSafeIdentifier(schema);

    const sql = new SQL(adminUrl);
    const config: AccountsConfig = { schema };

    await migrate(sql, config, appVersion);

    return new TestDatabase(schema, sql, adminUrl);
  }

  async dispose(): Promise<void> {
    assertSafeIdentifier(this.schema);
    await this.sql.unsafe(`drop schema if exists ${this.schema} cascade`);
    await this.sql.close();
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
      select 1 from information_schema.tables
      where table_schema = ${schema} and table_name = ${table}
    ) as exists
  `;
  return row.exists;
}

export async function schemaExists(sql: SQL, name: string): Promise<boolean> {
  const [row] = await sql`
    select exists (
      select 1 from information_schema.schemata
      where schema_name = ${name}
    ) as exists
  `;
  return row.exists;
}

export async function getDatabaseVersion(
  sql: SQL,
  schema: string,
): Promise<string> {
  const [row] = await sql.unsafe(`select version from ${schema}.version`);
  return row.version;
}
