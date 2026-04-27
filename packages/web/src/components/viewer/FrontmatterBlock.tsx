/**
 * Collapsible frontmatter display for view mode.
 *
 * Renders tree / meta / temporal as a compact inspector panel. Metadata rows
 * include a small filter button that merges the value into the current
 * advanced meta JSON filter, then switches search into advanced mode so the
 * filter takes effect immediately.
 *
 * Returns `null` when there is nothing to show (no tree, empty meta, no
 * temporal) so the view-mode pane stays uncluttered for bare memories.
 */

import type { ReactNode } from "react";
import {
  formatHumanTemporalTimestamp,
  formatLocalOffsetTimestamp,
} from "../../lib/datetime.ts";
import type { ParsedFrontmatter } from "../../lib/frontmatter.ts";
import { useFilter } from "../../store/filter.ts";
import { useLayout } from "../../store/layout.ts";
import { pushToast } from "../toast/Toast.tsx";

type Frontmatter = Pick<ParsedFrontmatter, "tree" | "meta" | "temporal">;

interface Props {
  frontmatter: Frontmatter;
}

export function FrontmatterBlock({ frontmatter }: Props) {
  const applyMetaJsonFilter = useFilter((s) => s.applyMetaJsonFilter);
  const setAdvanced = useFilter((s) => s.setAdvanced);
  const setMode = useFilter((s) => s.setMode);
  const setSearchCollapsed = useLayout((s) => s.setSearchCollapsed);

  const hasMeta = Object.keys(frontmatter.meta).length > 0;
  if (!frontmatter.tree && !hasMeta && !frontmatter.temporal) return null;

  function handleApplyMetaFilter(path: string[], value: unknown) {
    applyMetaJsonFilter(buildMetaFilter(path, value));
    setSearchCollapsed(false);
    pushToast(`Applied meta filter: ${formatPath(path)}`, "success");
  }

  function handleApplyTemporalFilter(timestamp: string) {
    setMode("advanced");
    setAdvanced({
      temporal: {
        mode: "contains",
        start: formatLocalOffsetTimestamp(timestamp),
        end: "",
      },
    });
    setSearchCollapsed(false);
    pushToast(
      `Applied temporal filter: contains ${formatHumanTemporalTimestamp(timestamp)}`,
      "success",
    );
  }

  return (
    <details className="mb-4 rounded-md border border-slate-200 bg-white">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-700">
        Frontmatter
      </summary>
      <div className="border-t border-slate-200 px-3 py-3 text-sm">
        <div className="space-y-3">
          {frontmatter.tree && (
            <FrontmatterField label="tree">
              <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">
                {frontmatter.tree}
              </code>
            </FrontmatterField>
          )}

          {frontmatter.temporal && (
            <TemporalBlock
              temporal={frontmatter.temporal}
              onApplyFilter={handleApplyTemporalFilter}
            />
          )}

          {hasMeta && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                meta
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50 py-1">
                {Object.entries(frontmatter.meta).map(([key, value]) => (
                  <MetaValueRow
                    key={key}
                    path={[key]}
                    name={key}
                    value={value}
                    depth={0}
                    onApplyFilter={handleApplyMetaFilter}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </details>
  );
}

function FrontmatterField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-2">
      <div className="text-xs font-semibold uppercase leading-5 tracking-wide text-slate-500">
        {label}
      </div>
      <div className="min-w-0 leading-5 text-slate-700">{children}</div>
    </div>
  );
}

function TemporalBlock({
  temporal,
  onApplyFilter,
}: {
  temporal: NonNullable<Frontmatter["temporal"]>;
  onApplyFilter: (timestamp: string) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        temporal
      </div>
      <div className="rounded-md border border-slate-200 bg-slate-50 py-1">
        <TemporalValueRow
          name="start"
          timestamp={temporal.start}
          onApplyFilter={onApplyFilter}
        />
        <TemporalValueRow
          name="end"
          timestamp={temporal.end ?? temporal.start}
          onApplyFilter={onApplyFilter}
        />
      </div>
    </div>
  );
}

function TemporalValueRow({
  name,
  timestamp,
  onApplyFilter,
}: {
  name: "start" | "end";
  timestamp: string;
  onApplyFilter: (timestamp: string) => void;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2 px-2 py-1 hover:bg-white">
      <span className="shrink-0 font-mono text-xs text-slate-500">{name}:</span>
      <code
        className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded bg-white px-1.5 py-0.5 font-mono text-xs text-slate-700 ring-1 ring-slate-200"
        title={timestamp}
      >
        {formatLocalOffsetTimestamp(timestamp)}
      </code>
      <button
        type="button"
        onClick={() => onApplyFilter(timestamp)}
        title={`Filter by temporal range containing ${name}`}
        aria-label={`Filter by temporal range containing ${name} ${formatHumanTemporalTimestamp(timestamp)}`}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-sky-100 hover:text-sky-700 focus:outline-none focus:ring-1 focus:ring-sky-500"
      >
        <FilterIcon />
      </button>
    </div>
  );
}

function MetaValueRow({
  path,
  name,
  value,
  depth,
  onApplyFilter,
}: {
  path: string[];
  name: string;
  value: unknown;
  depth: number;
  onApplyFilter: (path: string[], value: unknown) => void;
}) {
  const childEntries = isJsonObject(value) ? Object.entries(value) : [];

  return (
    <div>
      <div
        className="flex min-w-0 items-start gap-2 px-2 py-1 hover:bg-white"
        style={{ paddingLeft: `${0.5 + depth * 1}rem` }}
      >
        <span className="shrink-0 font-mono text-xs text-slate-500">
          {name}:
        </span>
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded bg-white px-1.5 py-0.5 font-mono text-xs text-slate-700 ring-1 ring-slate-200">
          {formatValue(value)}
        </code>
        <button
          type="button"
          onClick={() => onApplyFilter(path, value)}
          title={`Filter by meta ${formatPath(path)}`}
          aria-label={`Filter by meta ${formatPath(path)} equals ${formatValue(value, 160)}`}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-sky-100 hover:text-sky-700 focus:outline-none focus:ring-1 focus:ring-sky-500"
        >
          <FilterIcon />
        </button>
      </div>

      {childEntries.length > 0 &&
        childEntries.map(([childKey, childValue]) => (
          <MetaValueRow
            key={`${path.join("\u0000")}\u0000${childKey}`}
            path={[...path, childKey]}
            name={childKey}
            value={childValue}
            depth={depth + 1}
            onApplyFilter={onApplyFilter}
          />
        ))}
    </div>
  );
}

function FilterIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 5h16l-6 7v5l-4 2v-7L4 5z" />
    </svg>
  );
}

function buildMetaFilter(
  path: string[],
  value: unknown,
): Record<string, unknown> {
  const [firstKey, ...remainingPath] = path;
  if (firstKey === undefined) {
    throw new Error("Cannot build a meta filter without a path");
  }
  return {
    [firstKey]:
      remainingPath.length === 0
        ? value
        : buildMetaFilter(remainingPath, value),
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatPath(path: string[]): string {
  return path.join(".");
}

function formatValue(value: unknown, maxLength?: number): string {
  if (value === undefined) return "undefined";
  const json = JSON.stringify(value);
  const formattedValue = json === undefined ? String(value) : json;
  return maxLength === undefined
    ? formattedValue
    : truncate(formattedValue, maxLength);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1)}…`;
}
