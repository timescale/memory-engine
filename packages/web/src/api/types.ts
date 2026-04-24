/**
 * Type re-exports from `@memory.build/protocol` — the shared Zod schemas
 * there are the single source of truth for RPC shapes.
 *
 * Only `type` imports are used, so the protocol package's `zod` runtime
 * dependency is erased at compile time (the web tsconfig enables
 * `verbatimModuleSyntax`) and never reaches the browser bundle.
 */
import type { MemoryResponse } from "@memory.build/protocol/engine";

export type {
  MemoryDeleteResult,
  MemoryDeleteTreeResult,
  MemoryResponse as Memory,
  MemorySearchParams,
  MemorySearchResult,
  MemoryTreeResult,
  MemoryUpdateParams,
  MemoryWithScoreResponse as MemoryWithScore,
  TreeNodeResponse as TreePathCountNode,
} from "@memory.build/protocol/engine";

export type { TemporalFilter } from "@memory.build/protocol/fields";

/**
 * Non-null temporal range as returned on a memory response.
 *
 * The protocol's `Temporal` in `fields.ts` allows an optional/nullable
 * `end` because create/update accepts point-in-time ranges. Responses,
 * by contrast, always carry both fields (see the inline shape in
 * `memoryResponse`). Editor code needs the stricter read-side guarantee,
 * so we pin it to the non-null variant of `MemoryResponse["temporal"]`.
 */
export type Temporal = NonNullable<MemoryResponse["temporal"]>;
