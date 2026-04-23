/**
 * Read-only metadata panel.
 *
 * Displays the fields the user cannot edit: id, embedding status, createdAt,
 * updatedAt, createdBy. Rendered below the viewer/editor. Tree, meta, and
 * temporal are editable via the frontmatter in the editor, so they live
 * inside the editor pane, not here.
 */
import type { Memory } from "../../api/types.ts";

interface Props {
  memory: Memory;
}

export function MetadataPanel({ memory }: Props) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
      <Row label="ID">
        <span className="font-mono">{memory.id}</span>
      </Row>
      <Row label="Embedding">
        <span
          className={
            memory.hasEmbedding ? "text-emerald-700" : "text-slate-500"
          }
        >
          {memory.hasEmbedding ? "present" : "pending"}
        </span>
      </Row>
      <Row label="Created">
        <time dateTime={memory.createdAt}>
          {formatTimestamp(memory.createdAt)}
        </time>
      </Row>
      {memory.updatedAt && (
        <Row label="Updated">
          <time dateTime={memory.updatedAt}>
            {formatTimestamp(memory.updatedAt)}
          </time>
        </Row>
      )}
      {memory.createdBy && (
        <Row label="Created by">
          <span className="font-mono">{memory.createdBy}</span>
        </Row>
      )}
    </dl>
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
      <dt className="font-medium text-slate-500">{label}</dt>
      <dd className="text-slate-700">{children}</dd>
    </>
  );
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.toLocaleString()} (${iso})`;
  } catch {
    return iso;
  }
}
