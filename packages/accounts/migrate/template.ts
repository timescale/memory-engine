export function template(sql: string, vars: Record<string, unknown>): string {
  return sql.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) {
      throw new Error(`Missing template variable: ${key}`);
    }
    return String(vars[key]);
  });
}

export interface AccountsConfig {
  schema?: string;
}

export type ResolvedConfig = Required<AccountsConfig>;

export const defaultConfig: ResolvedConfig = {
  schema: "accounts",
};

export function resolveConfig(config?: AccountsConfig): ResolvedConfig {
  return { ...defaultConfig, ...config };
}
