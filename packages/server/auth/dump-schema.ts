// Prints the table/column shape better-auth expects for our exact plugin
// configuration. Used to diff against packages/database/auth/migrate when
// upgrading better-auth. Does not connect to the database.
import { getAuthTables } from "better-auth/db";
import { createBetterAuth } from "./betterauth.ts";

const { auth, pool } = createBetterAuth({
  databaseUrl: "postgresql://postgres@127.0.0.1:1/postgres",
  authSchema: "auth_dump",
  secret: "x".repeat(32),
  baseURL: "https://example.test",
  trustedOrigins: [],
  github: { clientId: "a", clientSecret: "b" },
});
const tables = getAuthTables(auth.options);
for (const [model, t] of Object.entries(tables)) {
  console.log(`\n== ${model} -> ${t.modelName}`);
  for (const [f, def] of Object.entries(t.fields)) {
    const d = def as Record<string, unknown>;
    const ref = d.references as { model: string; field: string } | undefined;
    console.log(
      `  ${String(d.fieldName ?? f).padEnd(28)} ${String(d.type).padEnd(10)} ${d.required ? "required" : "        "} ${d.unique ? "unique" : "      "} ${ref ? `-> ${ref.model}.${ref.field}` : ""}`,
    );
  }
}
await pool.end();
