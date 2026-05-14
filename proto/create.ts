const variables: Record<string, string> = {
  schema: "me_01",
  embedding_dimensions: "1536",
  bm25_text_config: "english",
  bm25_k1: "1.2",
  bm25_b: "0.75",
  hnsw_m: "16",
  hnsw_ef_construction: "64",
};

const input = await Bun.file(new URL("./create.sql", import.meta.url)).text();

const output = input.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, name) => {
  const value = variables[name];
  if (value === undefined) {
    throw new Error(`No value configured for placeholder ${match}`);
  }
  return value;
});

const unresolved = output.match(/\{\{[a-zA-Z0-9_]+\}\}/g);
if (unresolved) {
  throw new Error(`Unresolved placeholders: ${unresolved.join(", ")}`);
}

process.stdout.write(output);
