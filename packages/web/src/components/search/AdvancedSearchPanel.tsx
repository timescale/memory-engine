/**
 * Advanced search panel.
 *
 * Exposes every `memory.search` parameter. Lives directly under the mode
 * toggle when advanced mode is active. JSON in the meta field is parsed
 * live; on parse error the field shows a red border + inline message and
 * the value is dropped from the RPC (see `selectSearchParams`).
 */
import { useFilter } from "../../store/filter.ts";

export function AdvancedSearchPanel() {
  const advanced = useFilter((s) => s.advanced);
  const setAdvanced = useFilter((s) => s.setAdvanced);

  const metaError = validateMetaJson(advanced.metaJson);

  return (
    <div className="grid grid-cols-1 gap-4 rounded-md border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2">
      <Field label="semantic (vector)">
        <TextInput
          value={advanced.semantic}
          onChange={(v) => setAdvanced({ semantic: v })}
          placeholder="e.g. when was TypeScript created"
        />
      </Field>

      <Field label="fulltext (BM25)">
        <TextInput
          value={advanced.fulltext}
          onChange={(v) => setAdvanced({ fulltext: v })}
          placeholder="keywords"
        />
      </Field>

      <Field label="grep (regex)">
        <TextInput
          value={advanced.grep}
          onChange={(v) => setAdvanced({ grep: v })}
          placeholder="^def\\s+foo"
        />
      </Field>

      <Field label="tree (ltree filter)">
        <TextInput
          value={advanced.tree}
          onChange={(v) => setAdvanced({ tree: v })}
          placeholder="work.* or work.projects"
        />
      </Field>

      <Field label="meta (JSON)" error={metaError} className="sm:col-span-2">
        <textarea
          value={advanced.metaJson}
          onChange={(e) => setAdvanced({ metaJson: e.target.value })}
          rows={3}
          placeholder='{"priority":"high"}'
          className={[
            "w-full rounded-md border bg-white px-3 py-2 font-mono text-xs focus:outline-none focus:ring-1",
            metaError
              ? "border-red-500 focus:border-red-500 focus:ring-red-500"
              : "border-slate-300 focus:border-sky-500 focus:ring-sky-500",
          ].join(" ")}
        />
      </Field>

      <Field label="temporal" className="sm:col-span-2">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <select
            value={advanced.temporal.mode}
            onChange={(e) =>
              setAdvanced({
                temporal: {
                  ...advanced.temporal,
                  mode: e.target.value as "contains" | "overlaps" | "within",
                },
              })
            }
            className="rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"
          >
            <option value="contains">contains</option>
            <option value="overlaps">overlaps</option>
            <option value="within">within</option>
          </select>
          <input
            type="datetime-local"
            value={advanced.temporal.start}
            onChange={(e) =>
              setAdvanced({
                temporal: { ...advanced.temporal, start: e.target.value },
              })
            }
            className="rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"
          />
          <input
            type="datetime-local"
            value={advanced.temporal.end}
            onChange={(e) =>
              setAdvanced({
                temporal: { ...advanced.temporal, end: e.target.value },
              })
            }
            disabled={advanced.temporal.mode === "contains"}
            placeholder="end"
            className="rounded-md border border-slate-300 bg-white px-2 py-2 text-sm disabled:bg-slate-100 disabled:text-slate-400"
          />
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {advanced.temporal.mode === "contains"
            ? "contains: the memory's range contains this single point"
            : advanced.temporal.mode === "overlaps"
              ? "overlaps: the memory's range overlaps [start, end]"
              : "within: the memory's range is fully within [start, end]"}
        </p>
      </Field>

      <Field label="limit (max results)">
        <NumberInput
          value={advanced.limit}
          onChange={(v) => setAdvanced({ limit: v })}
          placeholder="1000 (default)"
          min={1}
          max={1000}
        />
      </Field>

      <Field label="candidateLimit">
        <NumberInput
          value={advanced.candidateLimit}
          onChange={(v) => setAdvanced({ candidateLimit: v })}
          placeholder="engine default"
          min={1}
          max={1000}
        />
      </Field>

      <Field label="weights.semantic (0–1)">
        <NumberInput
          value={advanced.weightsSemantic}
          onChange={(v) => setAdvanced({ weightsSemantic: v })}
          placeholder="0.5"
          step="0.05"
          min={0}
          max={1}
        />
      </Field>

      <Field label="weights.fulltext (0–1)">
        <NumberInput
          value={advanced.weightsFulltext}
          onChange={(v) => setAdvanced({ weightsFulltext: v })}
          placeholder="0.5"
          step="0.05"
          min={0}
          max={1}
        />
      </Field>

      <Field label="orderBy" className="sm:col-span-2">
        <select
          value={advanced.orderBy}
          onChange={(e) =>
            setAdvanced({
              orderBy: e.target.value as "" | "asc" | "desc",
            })
          }
          className="rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"
        >
          <option value="">(engine default)</option>
          <option value="asc">asc</option>
          <option value="desc">desc</option>
        </select>
      </Field>
    </div>
  );
}

function validateMetaJson(s: string): string | null {
  if (s.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(s);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "meta must be a JSON object";
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid JSON";
  }
}

function Field({
  label,
  error,
  className,
  children,
}: {
  label: string;
  error?: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  // Using a div rather than <label> because the Field is reused for multi-
  // input rows (e.g. temporal) where a single label cannot associate to one
  // input. Visual labeling only; per-input aria can be added when needed.
  return (
    <div className={`block ${className ?? ""}`}>
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </span>
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
    />
  );
}

function NumberInput({
  value,
  onChange,
  placeholder,
  min,
  max,
  step,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: string;
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      min={min}
      max={max}
      step={step}
      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
    />
  );
}
