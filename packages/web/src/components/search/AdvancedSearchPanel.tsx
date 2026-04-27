/**
 * Advanced search panel.
 *
 * Exposes every `memory.search` parameter. Lives directly under the mode
 * toggle when advanced mode is active. JSON in the meta field is parsed
 * live; on parse error the field shows a red border + inline message and
 * the value is dropped from the RPC (see `selectSearchParams`).
 */
import { useRef } from "react";
import {
  formatDatetimeLocalInputValue,
  localOffsetTimestampFromDatetimeLocalValue,
} from "../../lib/datetime.ts";
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
          <TemporalTimestampInput
            value={advanced.temporal.start}
            onChange={(value) =>
              setAdvanced({
                temporal: { ...advanced.temporal, start: value },
              })
            }
            placeholder="2026-02-17T12:23:11.570-08:00"
            pickerLabel="Pick start timestamp"
          />
          <TemporalTimestampInput
            value={advanced.temporal.end}
            onChange={(value) =>
              setAdvanced({
                temporal: { ...advanced.temporal, end: value },
              })
            }
            disabled={advanced.temporal.mode === "contains"}
            placeholder="end timestamp"
            pickerLabel="Pick end timestamp"
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

function TemporalTimestampInput({
  value,
  onChange,
  disabled = false,
  placeholder,
  pickerLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder: string;
  pickerLabel: string;
}) {
  const pickerRef = useRef<HTMLInputElement>(null);
  const pickerValue = formatDatetimeLocalInputValue(value);

  function handleOpenPicker() {
    const picker = pickerRef.current;
    if (!picker) return;
    try {
      picker.showPicker();
    } catch {
      picker.focus();
      picker.click();
    }
  }

  return (
    <div className="relative flex min-w-0 gap-1">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 py-2 font-mono text-xs focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 disabled:bg-slate-100 disabled:text-slate-400"
      />
      <button
        type="button"
        onClick={handleOpenPicker}
        disabled={disabled}
        title={pickerLabel}
        aria-label={pickerLabel}
        className="inline-flex w-9 shrink-0 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
      >
        <CalendarIcon />
      </button>
      <input
        ref={pickerRef}
        type="datetime-local"
        step="0.001"
        value={pickerValue}
        onChange={(e) =>
          onChange(localOffsetTimestampFromDatetimeLocalValue(e.target.value))
        }
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none absolute right-0 top-0 h-px w-px opacity-0"
      />
    </div>
  );
}

function CalendarIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <path d="M16 2v4" />
      <path d="M8 2v4" />
      <path d="M3 10h18" />
    </svg>
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
