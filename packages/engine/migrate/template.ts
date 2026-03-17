export function template(sql: string, vars: Record<string, unknown>): string {
  return sql.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) {
      throw new Error(`Missing template variable: ${key}`);
    }
    return String(vars[key]);
  });
}

// Global index/search configuration — same for all engines in a database.
// Schema is not included here because it's per-engine, not per-database.
export interface EngineConfig {
  embedding_dimensions?: number;
  bm25_text_config?: string;
  bm25_k1?: number;
  bm25_b?: number;
  hnsw_m?: number;
  hnsw_ef_construction?: number;
}

// All defaults filled in + per-engine schema attached. Used internally by template().
export type ResolvedConfig = Required<EngineConfig> & { schema: string };

export const defaultConfig: Required<EngineConfig> = {
  embedding_dimensions: 1536,
  bm25_text_config: "english",
  bm25_k1: 1.2,
  bm25_b: 0.75,
  hnsw_m: 16,
  hnsw_ef_construction: 64,
};

export function resolveConfig(
  schema: string,
  config?: EngineConfig,
): ResolvedConfig {
  return { ...defaultConfig, ...config, schema };
}
