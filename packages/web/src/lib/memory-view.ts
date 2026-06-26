/**
 * View-layer helpers for the selected-memory reading pane.
 *
 * The design shows a prominent title above the body. We derive that title
 * from the memory's `name` (the filename-like leaf) when set, otherwise from
 * the first markdown heading / line of the content — and, when the title was
 * lifted from a leading heading, strip that heading from the body so it isn't
 * rendered twice.
 */

export interface TitleAndBody {
  title: string;
  body: string;
}

const MAX_DERIVED_TITLE = 100;

export function deriveTitleAndBody(
  content: string,
  name: string | null,
): TitleAndBody {
  const lines = content.split("\n");
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);

  if (firstIdx === -1) {
    return { title: name ?? "Untitled memory", body: content };
  }

  const firstLine = lines[firstIdx]?.trim() ?? "";
  const heading = /^#{1,6}\s+(.*)$/.exec(firstLine);

  // A named memory keeps its full body — its content heading is real content,
  // not a duplicate of the (separately chosen) name.
  if (name) {
    return { title: name, body: content };
  }

  if (heading) {
    const title = truncate(heading[1]?.trim() ?? "", MAX_DERIVED_TITLE);
    const body = [...lines.slice(0, firstIdx), ...lines.slice(firstIdx + 1)]
      .join("\n")
      .replace(/^\n+/, "");
    return { title, body };
  }

  return { title: truncate(firstLine, MAX_DERIVED_TITLE), body: content };
}

/** Folder segments of a (ltree-dotted) tree path, for the breadcrumb. */
export function breadcrumbSegments(tree: string): string[] {
  if (!tree) return [];
  return tree.split(".").filter((s) => s.length > 0);
}

/** Tags rendered as pills — pulled from `meta.tags` when it's a string array. */
export function extractTags(meta: Record<string, unknown>): string[] {
  const tags = meta.tags;
  if (!Array.isArray(tags)) return [];
  return tags.filter(
    (t): t is string => typeof t === "string" && t.trim().length > 0,
  );
}

/** "Jun 18, 2026" style short date; echoes the input on a parse failure. */
export function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}
