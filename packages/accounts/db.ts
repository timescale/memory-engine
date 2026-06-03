import type { SQL } from "bun";
import {
  type DeviceAuthOps,
  deriveContext,
  deviceAuthOps,
  type EngineOps,
  engineOps,
  type IdentityOps,
  type InvitationOps,
  identityOps,
  invitationOps,
  type OAuthOps,
  type OrgMemberOps,
  type OrgOps,
  oauthOps,
  orgMemberOps,
  orgOps,
  type SessionOps,
  sessionOps,
  setLocalAccountsTimeouts,
} from "./ops";
import type { AccountsContext } from "./types";

type AllOps = DeviceAuthOps &
  IdentityOps &
  OrgOps &
  OrgMemberOps &
  EngineOps &
  InvitationOps &
  OAuthOps &
  SessionOps;

export interface AccountsDB extends AllOps {
  /** Execute operations within a transaction */
  withTransaction<T>(fn: (db: AccountsDB) => Promise<T>): Promise<T>;
}

function composeOps(ctx: AccountsContext): AllOps {
  return {
    ...deviceAuthOps(ctx),
    ...identityOps(ctx),
    ...orgOps(ctx),
    ...orgMemberOps(ctx),
    ...engineOps(ctx),
    ...invitationOps(ctx),
    ...oauthOps(ctx),
    ...sessionOps(ctx),
  };
}

export function createAccountsDB(sql: SQL, schema: string): AccountsDB {
  const ctx: AccountsContext = {
    sql,
    schema,
    inTransaction: false,
  };

  const ops = composeOps(ctx);

  const db: AccountsDB = {
    ...ops,

    async withTransaction<T>(fn: (db: AccountsDB) => Promise<T>): Promise<T> {
      return sql.begin(async (tx) => {
        await setLocalAccountsTimeouts(tx);
        await tx.unsafe(`SET LOCAL search_path TO ${schema}, public`);

        const txCtx = deriveContext(ctx, tx);
        const txOps = composeOps(txCtx);

        const txDb: AccountsDB = {
          ...txOps,
          withTransaction: <U>(nestedFn: (db: AccountsDB) => Promise<U>) =>
            nestedFn(txDb),
        };

        return fn(txDb);
      });
    },
  };

  return db;
}
