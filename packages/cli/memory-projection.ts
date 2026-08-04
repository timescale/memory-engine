import type {
  MemoryResponse,
  MemorySearchResult,
  MemoryWithScoreResponse,
} from "@memory.build/protocol/memory";
import { z } from "zod";

const bareSelectFields = [
  "id",
  "content",
  "meta",
  "tree",
  "name",
  "temporal",
  "score",
  "hasEmbedding",
  "createdAt",
  "createdBy",
  "updatedAt",
  "version",
  "versionHash",
] as const;

const contentSlicePattern = /^content:(\d+)(?::(\d*))?$/;
const metaKeyPrefix = "meta.";

export type BareSelectField = (typeof bareSelectFields)[number];

type ContentSlice = { start: number; end: number | null };

function parseContentSliceSpec(value: string): ContentSlice | null {
  const match = value.match(contentSlicePattern);
  if (!match) return null;

  const first = Number(match[1]);
  const second = match[2];
  if (!Number.isSafeInteger(first)) return null;

  if (second === undefined) return { start: 0, end: first };
  if (second === "") return { start: first, end: null };

  const end = Number(second);
  return Number.isSafeInteger(end) ? { start: first, end } : null;
}

export const selectFieldSpecSchema = z
  .string()
  .refine(
    (value) =>
      (bareSelectFields as readonly string[]).includes(value) ||
      (value.startsWith(metaKeyPrefix) &&
        value.length > metaKeyPrefix.length) ||
      parseContentSliceSpec(value) !== null,
    { message: "Invalid select field" },
  );

/** Nonempty presentation fields with at most one distinct content slice. */
export const selectSchema = z
  .array(selectFieldSpecSchema)
  .min(1, "Select at least one field")
  .superRefine((select, ctx) => {
    const slices = new Set(
      select.filter((field) => parseContentSliceSpec(field) !== null),
    );
    if (slices.size > 1) {
      ctx.addIssue({
        code: "custom",
        message: "Only one distinct content slice may be selected",
      });
    }
  });

export type ParsedSelect = {
  fields: Set<BareSelectField>;
  contentSlice?: ContentSlice;
  includeFullMeta: boolean;
  metaKeys: Set<string>;
};

export type ProjectedMemoryResponse = Partial<MemoryWithScoreResponse> & {
  contentLength?: number;
};

export type ProjectedMemorySearchResult = Omit<
  MemorySearchResult,
  "results"
> & {
  results: ProjectedMemoryResponse[];
};

/** Parse and validate presentation selectors for reuse across response rows. */
export function parseSelectFields(select: string[]): ParsedSelect {
  const validation = selectSchema.safeParse(select);
  if (!validation.success) {
    throw new Error(
      validation.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  const fields = validation.data;
  const parsed: ParsedSelect = {
    fields: new Set(),
    includeFullMeta: false,
    metaKeys: new Set(),
  };

  for (const field of fields) {
    const contentSlice = parseContentSliceSpec(field);
    if (contentSlice) {
      parsed.fields.add("content");
      parsed.contentSlice = contentSlice;
      continue;
    }

    if (field.startsWith(metaKeyPrefix)) {
      parsed.fields.add("meta");
      parsed.metaKeys.add(field.slice(metaKeyPrefix.length));
      continue;
    }

    const bare = field as BareSelectField;
    parsed.fields.add(bare);
    if (bare === "meta") parsed.includeFullMeta = true;
  }

  return parsed;
}

/** Project an already-shaped full client response for CLI/MCP presentation. */
export function projectMemory(
  memory: MemoryResponse | MemoryWithScoreResponse,
  select: ParsedSelect,
): ProjectedMemoryResponse {
  const projected: ProjectedMemoryResponse = {};

  if (select.fields.has("id")) projected.id = memory.id;
  if (select.fields.has("content")) {
    if (select.contentSlice) {
      const { start, end } = select.contentSlice;
      projected.content = memory.content.slice(start, end ?? undefined);
      projected.contentLength = memory.content.length;
    } else {
      projected.content = memory.content;
    }
  }
  if (select.fields.has("meta")) {
    if (select.includeFullMeta) {
      projected.meta = memory.meta;
    } else {
      projected.meta = Object.fromEntries(
        [...select.metaKeys]
          .filter((key) => Object.hasOwn(memory.meta, key))
          .map((key) => [key, memory.meta[key]]),
      );
    }
  }
  if (select.fields.has("tree")) projected.tree = memory.tree;
  if (select.fields.has("name")) projected.name = memory.name;
  if (select.fields.has("temporal")) projected.temporal = memory.temporal;
  if (select.fields.has("version")) projected.version = memory.version;
  if (select.fields.has("versionHash")) {
    projected.versionHash = memory.versionHash;
  }
  if (select.fields.has("hasEmbedding")) {
    projected.hasEmbedding = memory.hasEmbedding;
  }
  if (select.fields.has("createdAt")) projected.createdAt = memory.createdAt;
  if (select.fields.has("createdBy")) projected.createdBy = memory.createdBy;
  if (select.fields.has("updatedAt")) projected.updatedAt = memory.updatedAt;
  if (select.fields.has("score") && "score" in memory) {
    projected.score = memory.score;
  }

  return projected;
}

export function projectSearchResult(
  result: MemorySearchResult,
  select: ParsedSelect,
): ProjectedMemorySearchResult {
  return {
    ...result,
    results: result.results.map((memory) => projectMemory(memory, select)),
  };
}
