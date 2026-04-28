import type {
  AccountsContext,
  CreateEngineParams,
  Engine,
  EngineStatus,
} from "../types";
import { generateSlug } from "../util/slug";
import { withTx } from "./_tx";

interface EngineRow {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  shard_id: number;
  status: EngineStatus;
  language: string;
  created_at: Date;
  updated_at: Date | null;
}

function rowToEngine(row: EngineRow): Engine {
  return {
    id: row.id,
    orgId: row.org_id,
    slug: row.slug,
    name: row.name,
    shardId: row.shard_id,
    status: row.status,
    language: row.language,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function engineOps(ctx: AccountsContext) {
  const { schema } = ctx;

  return {
    async createEngine(params: CreateEngineParams): Promise<Engine> {
      const { id, orgId, name, shardId = 1, language = "english" } = params;
      const slug = generateSlug();

      return withTx(ctx, "createEngine", async (sql) => {
        const rows = await sql<EngineRow[]>`
          insert into ${sql.unsafe(schema)}.engine (id, org_id, slug, name, shard_id, language)
          values (${id ? sql`${id}::uuid` : sql`uuidv7()`}, ${orgId}, ${slug}, ${name}, ${shardId}, ${language})
          returning id, org_id, slug, name, shard_id, status, language, created_at, updated_at
        `;
        const row = rows[0];
        if (!row) {
          throw new Error("Failed to create engine");
        }
        return rowToEngine(row);
      });
    },

    async getEngine(id: string): Promise<Engine | null> {
      return withTx(ctx, "getEngine", async (sql) => {
        const [row] = await sql<EngineRow[]>`
          select id, org_id, slug, name, shard_id, status, language, created_at, updated_at
          from ${sql.unsafe(schema)}.engine
          where id = ${id}
        `;
        return row ? rowToEngine(row) : null;
      });
    },

    async getEngineBySlug(slug: string): Promise<Engine | null> {
      return withTx(ctx, "getEngineBySlug", async (sql) => {
        const [row] = await sql<EngineRow[]>`
          select id, org_id, slug, name, shard_id, status, language, created_at, updated_at
          from ${sql.unsafe(schema)}.engine
          where slug = ${slug}
        `;
        return row ? rowToEngine(row) : null;
      });
    },

    async updateEngine(
      id: string,
      params: { name?: string; status?: EngineStatus },
    ): Promise<boolean> {
      const { name, status } = params;
      if (name === undefined && status === undefined) {
        return false;
      }

      return withTx(ctx, "updateEngine", async (sql) => {
        const result = await sql`
          update ${sql.unsafe(schema)}.engine
          set
            ${name !== undefined ? sql`name = ${name},` : sql``}
            ${status !== undefined ? sql`status = ${status},` : sql``}
            updated_at = now()
          where id = ${id}
        `;
        return result.count > 0;
      });
    },

    async listEnginesByOrg(orgId: string): Promise<Engine[]> {
      return withTx(ctx, "listEnginesByOrg", async (sql) => {
        const rows = await sql<EngineRow[]>`
          select id, org_id, slug, name, shard_id, status, language, created_at, updated_at
          from ${sql.unsafe(schema)}.engine
          where org_id = ${orgId}
          order by created_at
        `;
        return rows.map(rowToEngine);
      });
    },

    /**
     * Hard-delete an engine row. Returns true if a row was deleted, false
     * if no row matched. Caller is responsible for first dropping the
     * engine schema; this only removes the accounts-side metadata.
     */
    async deleteEngine(id: string): Promise<boolean> {
      return withTx(ctx, "deleteEngine", async (sql) => {
        const result = await sql`
          delete from ${sql.unsafe(schema)}.engine
          where id = ${id}
        `;
        return result.count > 0;
      });
    },

    /** List all active engines across all orgs (for embedding worker discovery) */
    async listActiveEngines(): Promise<{ slug: string; shardId: number }[]> {
      return withTx(ctx, "listActiveEngines", async (sql) => {
        const rows = await sql<{ slug: string; shard_id: number }[]>`
          select slug, shard_id
          from ${sql.unsafe(schema)}.engine
          where status = 'active'
        `;
        return rows.map((r) => ({ slug: r.slug, shardId: r.shard_id }));
      });
    },
  };
}

export type EngineOps = ReturnType<typeof engineOps>;
