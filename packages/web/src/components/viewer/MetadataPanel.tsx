/**
 * Read-only metadata inspector — the immutable identifiers the user can't
 * edit (id, embedding status, created-by). Created/updated timestamps live in
 * the reading view's meta row; tree / meta / temporal are editable via the
 * frontmatter block. Rendered as a collapsible details block to keep the
 * reading view uncluttered.
 */
import type { MemoryResponse } from "@memory.build/client";

interface Props {
  memory: MemoryResponse;
}

export function MetadataPanel({ memory }: Props) {
  return (
    <details className="rounded-lg border border-ink/[0.12]">
      <summary className="cursor-pointer select-none px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink/50 hover:text-ink">
        metadata
      </summary>
      <div className="border-t border-ink/[0.12] px-3 py-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
          <Row label="id">
            <span className="font-mono text-ink/80">{memory.id}</span>
          </Row>
          <Row label="embedding">
            <span
              className={memory.hasEmbedding ? "text-ink/80" : "text-ink/50"}
            >
              {memory.hasEmbedding ? "present" : "pending"}
            </span>
          </Row>
          {memory.createdBy && (
            <Row label="created by">
              <span className="font-mono text-ink/80">{memory.createdBy}</span>
            </Row>
          )}
        </dl>
      </div>
    </details>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className="font-mono uppercase tracking-[0.04em] text-ink/45">
        {label}
      </dt>
      <dd className="min-w-0 break-all text-ink/80">{children}</dd>
    </>
  );
}
