import { info, reportError, span } from "@pydantic/logfire-node";
import { SQL, semver } from "bun";

const REQUIRED_EXTENSIONS = [
  { name: "citext", minVersion: "1.6" },
  { name: "ltree", minVersion: "1.3" },
  { name: "vector", minVersion: "0.8.2" },
  { name: "pg_textsearch", minVersion: "1.1.0" },
] as const;

export async function bootstrapEngineDatabase(
  sql: SQL,
  statementTimeout: string = "20s",
  lockTimeout: string = "5s",
  transactionTimeout: string = "30s",
  idleInTransactionSessionTimeout: string = "30s",
  shardId?: number,
): Promise<void> {
  const attributes = {
    "db.shard": shardId,
    "db.statement_timeout": statementTimeout,
    "db.lock_timeout": lockTimeout,
    "db.transaction_timeout": transactionTimeout,
    "db.idle_in_transaction_session_timeout": idleInTransactionSessionTimeout,
    "engine_core.required_extensions": REQUIRED_EXTENSIONS.map(
      (extension) => `${extension.name}@>=${extension.minVersion}`,
    ),
  };

  await span("engine_core.bootstrap", {
    attributes,
    callback: async () => {
      try {
        await sql.begin(async (tx) => {
          if (shardId !== undefined) {
            await tx.unsafe(`set local pgdog.shard to ${String(shardId)}`);
          }
          await ensurePostgresVersion(tx);
          await span("engine_core.bootstrap.acquire_lock", {
            callback: () => acquireAdvisoryLock(tx),
          });
          await tx`select set_config('statement_timeout', ${statementTimeout}, true)`;
          await tx`select set_config('lock_timeout', ${lockTimeout}, true)`;
          await tx`select set_config('transaction_timeout', ${transactionTimeout}, true)`;
          await tx`select set_config('idle_in_transaction_session_timeout', ${idleInTransactionSessionTimeout}, true)`;
          for (const extension of REQUIRED_EXTENSIONS) {
            await span("engine_core.bootstrap.ensure_extension", {
              attributes: {
                "db.extension": extension.name,
                "db.extension_min_version": extension.minVersion,
              },
              callback: () =>
                ensureExtension(tx, extension.name, extension.minVersion),
            });
          }
          /* TODO: remove
          await span("engine_core.bootstrap.ensure_roles", {
            callback: () => ensureRoles(tx),
          });
          */
        });
        info("Engine core bootstrap completed", attributes);
      } catch (error) {
        reportError("Engine core bootstrap failed", error as Error, attributes);
        throw error;
      }
    },
  });
}

const MAX_LOCK_RETRIES = 5;
const BASE_DELAY_MS = 100;
const BOOTSTRAP_LOCK_ID = 1982010637711;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireAdvisoryLock(tx: SQL): Promise<void> {
  let acquired = false;
  for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt++) {
    const [result] = await tx`
      select pg_try_advisory_xact_lock(${BOOTSTRAP_LOCK_ID}) as acquired
    `;
    if (result.acquired) {
      acquired = true;
      break;
    }
    if (attempt < MAX_LOCK_RETRIES - 1) {
      await sleep(BASE_DELAY_MS * 2 ** attempt);
    }
  }

  if (!acquired) {
    throw new Error(`Failed to acquire advisory lock`);
  }
}

async function ensurePostgresVersion(tx: SQL): Promise<void> {
  const [{ server_version_num }] = await tx`
    select current_setting('server_version_num')::int as server_version_num
  `;
  if (server_version_num < 180000) {
    throw new Error(
      `PostgreSQL version 18 or higher is required (found ${server_version_num})`,
    );
  }
}

async function ensureExtension(
  tx: SQL,
  name: string,
  minVersion: string,
): Promise<void> {
  const [installed] = await tx`
    select x.extversion, n.nspname
    from pg_extension x
    inner join pg_namespace n on (x.extnamespace = n.oid)
    where x.extname = ${name}
  `;

  if (installed) {
    if (
      installed.nspname === "public" &&
      semver.order(installed.extversion, minVersion) >= 0
    ) {
      return;
    }
    throw new Error(
      `Extension "${name}" version ${minVersion} or higher is required in the "public" schema (found ${installed.extversion} installed in "${installed.nspname}")`,
    );
  }

  const [available] = await tx`
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
    await tx`create extension if not exists ${tx(name)} with schema public`;
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

/* TODO: remove this
async function ensureRoles(tx: SQL): Promise<void> {
  await tx.unsafe(`
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
*/
