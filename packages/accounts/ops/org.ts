import type { AccountsContext, CreateOrgParams, Org } from "../types";
import { generateSlug } from "../util/slug";
import { withTx } from "./_tx";

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  created_at: Date;
  updated_at: Date | null;
}

function rowToOrg(row: OrgRow): Org {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function orgOps(ctx: AccountsContext) {
  const { schema } = ctx;

  return {
    async createOrg(params: CreateOrgParams): Promise<Org> {
      const { id, name } = params;
      const slug = generateSlug();

      return withTx(ctx, async (sql) => {
        const rows = await sql<OrgRow[]>`
          insert into ${sql.unsafe(schema)}.org (id, slug, name)
          values (${id ? sql`${id}::uuid` : sql`uuidv7()`}, ${slug}, ${name})
          returning id, slug, name, created_at, updated_at
        `;
        const row = rows[0];
        if (!row) {
          throw new Error("Failed to create org");
        }
        return rowToOrg(row);
      });
    },

    async getOrg(id: string): Promise<Org | null> {
      return withTx(ctx, async (sql) => {
        const [row] = await sql<OrgRow[]>`
          select id, slug, name, created_at, updated_at
          from ${sql.unsafe(schema)}.org
          where id = ${id}
        `;
        return row ? rowToOrg(row) : null;
      });
    },

    async getOrgBySlug(slug: string): Promise<Org | null> {
      return withTx(ctx, async (sql) => {
        const [row] = await sql<OrgRow[]>`
          select id, slug, name, created_at, updated_at
          from ${sql.unsafe(schema)}.org
          where slug = ${slug}
        `;
        return row ? rowToOrg(row) : null;
      });
    },

    async updateOrg(id: string, params: { name?: string }): Promise<boolean> {
      const { name } = params;
      if (name === undefined) {
        return false;
      }

      return withTx(ctx, async (sql) => {
        const result = await sql`
          update ${sql.unsafe(schema)}.org
          set
            name = ${name},
            updated_at = now()
          where id = ${id}
        `;
        return result.count > 0;
      });
    },

    async deleteOrg(id: string): Promise<boolean> {
      return withTx(ctx, async (sql) => {
        const result = await sql`
          delete from ${sql.unsafe(schema)}.org
          where id = ${id}
        `;
        return result.count > 0;
      });
    },

    async listOrgsByIdentity(identityId: string): Promise<Org[]> {
      return withTx(ctx, async (sql) => {
        const rows = await sql<OrgRow[]>`
          select o.id, o.slug, o.name, o.created_at, o.updated_at
          from ${sql.unsafe(schema)}.org o
          inner join ${sql.unsafe(schema)}.org_member m on m.org_id = o.id
          where m.identity_id = ${identityId}
          order by o.created_at
        `;
        return rows.map(rowToOrg);
      });
    },
  };
}

export type OrgOps = ReturnType<typeof orgOps>;
