import type { SQL } from "bun";
import {
  engineOps,
  identityOps,
  invitationOps,
  oauthOps,
  orgMemberOps,
  orgOps,
  sessionOps,
  deriveContext,
  type EngineOps,
  type IdentityOps,
  type InvitationOps,
  type OAuthOps,
  type OrgMemberOps,
  type OrgOps,
  type SessionOps,
} from "./ops";
import type { AccountsContext, AccountsCrypto } from "./types";
import { createAccountsCrypto } from "./util/crypto";

export interface CreateAccountsDBOptions {
  masterKey: Buffer;
}

type AllOps = IdentityOps &
  OrgOps &
  OrgMemberOps &
  EngineOps &
  InvitationOps &
  OAuthOps &
  SessionOps;

export interface AccountsDB extends AllOps {
  /** Create a new encryption data key (does not activate) */
  createDataKey(): Promise<number>;
  /** Activate an encryption data key */
  activateDataKey(keyId: number): Promise<void>;
  /** Execute operations within a transaction */
  withTransaction<T>(fn: (db: AccountsDB) => Promise<T>): Promise<T>;
}

function composeOps(ctx: AccountsContext): AllOps {
  return {
    ...identityOps(ctx),
    ...orgOps(ctx),
    ...orgMemberOps(ctx),
    ...engineOps(ctx),
    ...invitationOps(ctx),
    ...oauthOps(ctx),
    ...sessionOps(ctx),
  };
}

export function createAccountsDB(
  sql: SQL,
  schema: string,
  options: CreateAccountsDBOptions,
): AccountsDB {
  const crypto = createAccountsCrypto(options.masterKey, { sql, schema });

  const ctx: AccountsContext = {
    sql,
    schema,
    inTransaction: false,
    crypto,
  };

  const ops = composeOps(ctx);

  const db: AccountsDB = {
    ...ops,

    createDataKey(): Promise<number> {
      return crypto.createDataKey();
    },

    activateDataKey(keyId: number): Promise<void> {
      return crypto.activateDataKey(keyId);
    },

    async withTransaction<T>(fn: (db: AccountsDB) => Promise<T>): Promise<T> {
      return sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL search_path TO ${schema}, public`);

        const txCrypto = createAccountsCrypto(options.masterKey, {
          sql: tx,
          schema,
        });
        const txCtx = deriveContext({ ...ctx, crypto: txCrypto }, tx);
        const txOps = composeOps(txCtx);

        const txDb: AccountsDB = {
          ...txOps,
          createDataKey: () => txCrypto.createDataKey(),
          activateDataKey: (keyId) => txCrypto.activateDataKey(keyId),
          withTransaction: <U>(nestedFn: (db: AccountsDB) => Promise<U>) =>
            nestedFn(txDb),
        };

        return fn(txDb);
      });
    },
  };

  return db;
}
