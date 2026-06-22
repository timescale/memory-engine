#!/usr/bin/env bun
/**
 * Post-ETL verification — READ-ONLY against all three databases.
 *
 *   DB_ACCOUNTS=… DB_SHARD=… DATABASE_URL=… bun packages/migrate-prod/verify.ts
 *
 * Reconciles the target against the sources (PROD_MIGRATION_RUNBOOK.md §5):
 * identity/user counts + the auth.users == core.principal invariant, per-space
 * memory counts (target vs source shard), ≥1 admin per space, every member's
 * effective access non-empty, and the Tiger-Den access-parity spot-check. Works
 * for a subset run (a smoke test) — it only checks the spaces present in the
 * target. Prints a ✓/✗ checklist and exits non-zero on any failure.
 */
import postgres, { type Sql } from "postgres";
import {
  DEFAULT_CONFIG as C,
  sourceSpaceSchema,
  targetSpaceSchema,
} from "./schemas";

function ro(url: string): Sql {
  return postgres(url, {
    max: 2,
    connect_timeout: 10,
    connection: {
      default_transaction_read_only: true,
      statement_timeout: 60_000,
    },
    onnotice: () => {},
  });
}
function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var ${name}.`);
    process.exit(1);
  }
  return v;
}

let pass = 0;
let fail = 0;
function check(ok: boolean, name: string, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function count(sql: Sql, q: string): Promise<number> {
  const [r] = await sql.unsafe(q);
  return Number((r as { n: number } | undefined)?.n ?? 0);
}
type Grant = { tree_path: string; access: number };
async function treeAccess(
  target: Sql,
  memberId: string,
  spaceId: string,
): Promise<Grant[]> {
  const [r] =
    await target`select ${target(C.coreSchema)}.build_tree_access(${memberId}, ${spaceId}) as ta`;
  return (r?.ta as Grant[]) ?? [];
}
const reaches = (ta: Grant[], path: string, lvl: number) =>
  ta.some((g) => g.tree_path === path && g.access >= lvl);

async function main(): Promise<void> {
  const accounts = ro(need("DB_ACCOUNTS"));
  const shard = ro(need("DB_SHARD"));
  const target = ro(process.env.DATABASE_URL ?? need("DB_TARGET"));
  try {
    // --- control plane (always migrated in full) ---
    const srcIdent = await count(
      accounts,
      `select count(*)::int n from ${C.accountsSchema}.identity`,
    );
    const tgtUsers = await count(
      target,
      `select count(*)::int n from ${C.authSchema}.users`,
    );
    const tgtPrin = await count(
      target,
      `select count(*)::int n from ${C.coreSchema}.principal where kind='u'`,
    );
    const inv = await count(
      target,
      `select count(*)::int n from ${C.authSchema}.users u
         join ${C.coreSchema}.principal p on p.id = u.id and p.kind='u'`,
    );
    check(
      srcIdent === tgtUsers && tgtUsers === tgtPrin && tgtPrin === inv,
      "identities → auth.users → core.principal(u) all equal",
      `identity=${srcIdent} users=${tgtUsers} principals=${tgtPrin} invariant-join=${inv}`,
    );

    const srcOauth = await count(
      accounts,
      `select count(*)::int n from ${C.accountsSchema}.oauth_account`,
    );
    const tgtAcct = await count(
      target,
      `select count(*)::int n from ${C.authSchema}.accounts`,
    );
    check(
      srcOauth === tgtAcct,
      "oauth accounts copied",
      `source=${srcOauth} target=${tgtAcct}`,
    );

    const srcSess = await count(
      accounts,
      `select count(*)::int n from ${C.accountsSchema}.session where expires_at > now()`,
    );
    const tgtSess = await count(
      target,
      `select count(*)::int n from ${C.authSchema}.sessions`,
    );
    check(
      tgtSess <= srcSess && tgtSess > 0,
      "live sessions copied (≤ source; some may expire between runs)",
      `source-live=${srcSess} target=${tgtSess}`,
    );

    // --- per-space (whatever is in the target — subset-aware) ---
    const spaces = await target<{ id: string; slug: string; name: string }[]>`
      select id, slug, name from ${target(C.coreSchema)}.space order by slug`;
    console.log(`\nspaces in target: ${spaces.length}`);
    for (const s of spaces) {
      const tgt = await count(
        target,
        `select count(*)::int n from ${targetSpaceSchema(C, s.slug)}.memory`,
      );
      const src = await count(
        shard,
        `select count(*)::int n from ${sourceSpaceSchema(C, s.slug)}.memory`,
      );
      check(
        tgt === src,
        `memory count matches source — ${s.slug} (${s.name})`,
        `source=${src} target=${tgt}`,
      );

      const admins = await count(
        target,
        `select count(*)::int n from ${C.coreSchema}.principal_space where space_id='${s.id}' and admin`,
      );
      check(admins >= 1, `≥1 admin — ${s.slug}`, `admins=${admins}`);

      // every member's effective access is non-empty (the auth gate)
      const members = await target<
        { id: string; name: string; admin: boolean }[]
      >`
        select pr.id, pr.name, ps.admin
        from ${target(C.coreSchema)}.principal_space ps
        join ${target(C.coreSchema)}.principal pr on pr.id = ps.principal_id
        where ps.space_id = ${s.id} and pr.kind in ('u','a')`;
      for (const m of members) {
        const ta = await treeAccess(target, m.id, s.id);
        check(
          ta.length > 0,
          `effective access non-empty — ${s.slug}/${m.name}`,
          `grants=${ta.length}`,
        );
      }

      // Tiger-Den access parity (only when that engine is present)
      if (s.slug === "5ld4wito9c8o") {
        const owner = members.find((m) => m.admin);
        const member = members.find((m) => !m.admin);
        if (owner)
          check(
            reaches(await treeAccess(target, owner.id, s.id), "", 3),
            "tiger-den owner has owner@root",
            owner.name,
          );
        if (member) {
          const ta = await treeAccess(target, member.id, s.id);
          check(
            reaches(ta, "tigerden.shared", 2) &&
              reaches(ta, "tigerden.me_pilot", 1),
            "tiger-den member inherits the group's grants",
            `${member.name}: shared≥write & me_pilot≥read`,
          );
        }
      }
    }

    console.log(
      `\n${fail === 0 ? "✓ all checks passed" : `✗ ${fail} check(s) FAILED`}  (${pass} passed)`,
    );
    if (fail > 0) process.exitCode = 1;
  } finally {
    await Promise.all([accounts.end(), shard.end(), target.end()]);
  }
}

await main();
