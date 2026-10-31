"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, Check, ChevronDown, KeyRound, Search, Sparkles, Wand2 } from "lucide-react";
import {
  CLIENT_IMPORT_FIELDS,
  labelOf,
  SMART_IDENTITY_FIELDS,
  type ClientImportFieldKey,
  type MappingSuggestion,
  type SmartFieldRule,
  type SmartMapping,
  type SmartRuleKey,
  type SmartSamples,
} from "@support-automation/shared";
import { previewRow, type PreviewCell, type PreviewSourceRow } from "@/lib/smartMappingPreview";

/**
 * The Visual Mapping grid — the DEFAULT Advanced Mapping screen (Smart Import V5 §1). Laid out like the
 * spreadsheet it maps: Get Assist's fields across the TOP, directly below each one the picker for the Excel
 * column that feeds it, and below that the file's real rows, one client per row, each cell showing what the
 * file says and, under it, the value after normalization or the value derived for it. Changing a picker
 * re-renders the column at once: the preview is computed here from the rows already loaded.
 *
 * Presentational only (no server action): MappingEditor owns the mapping, its saving and the presets, and the
 * Detailed view edits the SAME mapping object, so switching views never loses a choice.
 */

export interface MappingGridProps {
  groups: ReadonlyArray<{ title: string; fields: readonly ClientImportFieldKey[] }>;
  headers: readonly string[];
  columnFilled: Readonly<Record<string, number>>;
  mapping: SmartMapping;
  samples: SmartSamples;
  previewRows: readonly PreviewSourceRow[];
  defaultCountry: string | null;
  suggestions: readonly MappingSuggestion[];
  choices: Partial<Record<ClientImportFieldKey, ReadonlyArray<{ value: string; label: string }>>>;
  onRule: (field: SmartRuleKey, rule: SmartFieldRule | undefined) => void;
}

const REQUIRED = new Set<ClientImportFieldKey>(CLIENT_IMPORT_FIELDS.filter((f) => f.required).map((f) => f.key));
const IDENTITY = new Set<string>(SMART_IDENTITY_FIELDS);

export function MappingGrid(props: MappingGridProps) {
  const { groups, mapping, samples, previewRows, defaultCountry } = props;
  const fields = useMemo(() => groups.flatMap((g) => g.fields), [groups]);
  // Recomputed on every change of the mapping: this IS the "preview updates at once".
  const preview = useMemo(
    () => previewRows.map((r) => ({ rowNumber: r.rowNumber, cells: previewRow(r, mapping, samples, fields, { defaultCountry, fillLocale: mapping.fillLocale !== false }) })),
    [previewRows, mapping, samples, fields, defaultCountry],
  );
  const problems = useMemo(() => {
    const count = new Map<ClientImportFieldKey, number>();
    for (const row of preview) for (const f of fields) if (row.cells[f]?.tone === "problem") count.set(f, (count.get(f) ?? 0) + 1);
    return count;
  }, [preview, fields]);

  return (
    <div
      role="region"
      aria-label="Visual mapping: your fields across the top, the Excel column for each below it, and your file's rows under that"
      tabIndex={0}
      data-mapping-view="grid"
      className="relative max-h-[72vh] overflow-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
    >
      <table className="border-separate border-spacing-0 text-[12.5px]">
        <thead className="sticky top-0 z-20">
          <tr data-row="groups">
            <th rowSpan={2} scope="col" className="sticky left-0 z-30 min-w-[104px] border-b border-r border-[var(--color-border)] bg-[var(--color-neutral-bg)] px-3 py-2 text-left align-bottom text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              Get Assist field
            </th>
            {groups.map((g) => (
              <th key={g.title} colSpan={g.fields.length} scope="colgroup" className="border-b border-r border-[var(--color-border)] bg-[var(--color-neutral-bg)] px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                {g.title}
              </th>
            ))}
          </tr>
          <tr data-row="fields">
            {fields.map((field) => {
              const rule = mapping.fields[field];
              const missingRequired = REQUIRED.has(field) && !rule;
              const n = problems.get(field) ?? 0;
              return (
                <th key={field} scope="col" data-field={field} className="min-w-[200px] max-w-[260px] border-b border-r border-[var(--color-border)] bg-[var(--color-surface)] px-3 pt-2 pb-1 text-left align-top font-medium">
                  <span className="flex flex-wrap items-center gap-1.5 text-[13px] text-[color:var(--color-foreground)]">
                    {labelOf(field)}
                    {REQUIRED.has(field) ? <span className="rounded bg-[var(--color-info-bg)] px-1 text-[10.5px] font-semibold text-[color:var(--color-info-fg)]">required</span> : null}
                    {IDENTITY.has(field) ? <KeyRound className="size-3.5 text-[color:var(--color-muted-foreground)]" aria-label="identifies a client" /> : null}
                  </span>
                  {missingRequired ? (
                    <span className="mt-0.5 flex items-center gap-1 text-[11px] font-normal text-[color:var(--color-danger-fg)]">
                      <AlertTriangle className="size-3" aria-hidden /> Not mapped — every client needs this
                    </span>
                  ) : n ? (
                    <span className="mt-0.5 flex items-center gap-1 text-[11px] font-normal text-[color:var(--color-warning-fg)]">
                      <AlertTriangle className="size-3" aria-hidden /> {n} of {preview.length} shown need a look
                    </span>
                  ) : null}
                </th>
              );
            })}
          </tr>
          <tr data-row="sources">
            <th scope="row" className="sticky left-0 z-30 border-b-2 border-r border-[var(--color-border)] bg-[var(--color-neutral-bg)] px-3 py-2 text-left align-top text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              Excel column
            </th>
            {fields.map((field) => (
              <td key={field} data-field={field} className="border-b-2 border-r border-[var(--color-border)] bg-[var(--color-surface)] px-2 pb-2 align-top">
                <SourceCell field={field} {...props} />
              </td>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.length === 0 ? (
            <tr>
              <td colSpan={fields.length + 1} className="px-3 py-6 text-center text-[color:var(--color-muted-foreground)]">
                The file has no rows to preview.
              </td>
            </tr>
          ) : (
            preview.map((row) => (
              <tr key={row.rowNumber} data-row="preview" data-row-number={row.rowNumber}>
                <th scope="row" className="sticky left-0 z-10 border-b border-r border-[var(--color-border)] bg-[var(--color-neutral-bg)] px-3 py-1.5 text-left align-top text-[11.5px] font-medium tabular-nums text-[color:var(--color-muted-foreground)]">
                  Row {row.rowNumber}
                </th>
                {fields.map((field) => (
                  <td key={field} data-field={field} className="max-w-[260px] border-b border-r border-[var(--color-border)] px-3 py-1.5 align-top">
                    <PreviewValue cell={row.cells[field]} />
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function PreviewValue({ cell }: { cell: PreviewCell | undefined }) {
  if (!cell || cell.tone === "empty") return <span className="text-[color:var(--color-subtle-foreground)]">—</span>;
  return (
    <span className="block min-w-0" title={cell.note ?? undefined}>
      {cell.original ? (
        <span className={`block truncate ${cell.tone === "problem" ? "text-[color:var(--color-danger-fg)]" : ""}`} dir="auto">
          {cell.original}
          {cell.fromFallback ? <span className="ml-1 text-[10.5px] text-[color:var(--color-muted-foreground)]">(if-empty column)</span> : null}
        </span>
      ) : null}
      {cell.tone === "changed" && cell.value ? (
        <span data-normalized className="mt-0.5 flex items-center gap-1 truncate text-[11.5px] text-[color:var(--color-success-fg)]" dir="auto">
          <Check className="size-3 shrink-0" aria-hidden />
          {cell.value}
        </span>
      ) : null}
      {cell.tone === "derived" && cell.value ? (
        <span data-derived className="mt-0.5 flex items-center gap-1 truncate text-[11.5px] text-[color:var(--color-info-fg)]" dir="auto">
          <Sparkles className="size-3 shrink-0" aria-hidden />
          {cell.value}
          <span className="sr-only"> (Auto selected: {cell.note})</span>
        </span>
      ) : null}
      {cell.tone === "problem" ? (
        <span className="mt-0.5 flex items-start gap-1 text-[11px] leading-snug text-[color:var(--color-danger-fg)]">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span className="line-clamp-2">{cell.note}</span>
        </span>
      ) : null}
    </span>
  );
}

// ── The picker under each field ─────────────────────────────────────────────────────────────────

type Option = { key: string; label: string; hint?: string; rule: SmartFieldRule | undefined | "constant" };

function SourceCell({ field, mapping, headers, columnFilled, samples, suggestions, choices, onRule }: MappingGridProps & { field: ClientImportFieldKey }) {
  const rule = mapping.fields[field];
  const suggestion = !rule ? suggestions.find((s) => s.field === field) : undefined;
  const options: Option[] = [
    { key: "empty", label: "Leave empty", rule: undefined },
    { key: "constant", label: "Same value for every row…", rule: "constant" },
    ...(samples[field] ? [{ key: "sample", label: `Sample value: ${samples[field]}`, rule: { mode: "sample" } as SmartFieldRule }] : []),
    ...headers.map((h) => ({ key: `col:${h}`, label: h, hint: `${(columnFilled[h] ?? 0).toLocaleString()} filled`, rule: { mode: "source", column: h } as SmartFieldRule })),
  ];
  const current = !rule ? "empty" : rule.mode === "source" ? `col:${rule.column}` : rule.mode === "sample" || (rule.mode === "constant" && rule.sample) ? "sample" : rule.mode === "constant" ? "constant" : "empty";
  const choose = (o: Option) => {
    if (o.rule === "constant") onRule(field, { mode: "constant", value: rule?.mode === "constant" && !rule.sample ? rule.value : (choices[field]?.[0]?.value ?? "") });
    else onRule(field, o.rule);
  };

  return (
    <div className="space-y-1.5 pt-1">
      <ColumnPicker field={field} options={options} current={current} required={REQUIRED.has(field)} onChoose={choose} />
      {suggestion ? (
        <button
          type="button"
          onClick={() => onRule(field, { mode: "source", column: suggestion.column })}
          title={suggestion.reason}
          className="flex w-full items-center gap-1 rounded-[var(--radius-sm)] border border-dashed border-[var(--color-info-border)] px-1.5 py-1 text-left text-[11px] text-[color:var(--color-info-fg)] hover:bg-[var(--color-info-bg)]"
        >
          <Wand2 className="size-3 shrink-0" aria-hidden />
          <span className="truncate">Use “{suggestion.column}”?</span>
        </button>
      ) : null}
      {rule?.mode === "source" ? (
        <select
          aria-label={`If the ${rule.column} cell is empty, for ${labelOf(field)}`}
          value={rule.fallback ?? ""}
          onChange={(e) => onRule(field, { mode: "source", column: rule.column, ...(e.target.value ? { fallback: e.target.value } : {}) })}
          className="h-7 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-[11px] text-[color:var(--color-muted-foreground)]"
        >
          <option value="">If empty: leave empty</option>
          {headers
            .filter((h) => h !== rule.column)
            .map((h) => (
              <option key={h} value={h}>
                If empty: use {h}
              </option>
            ))}
        </select>
      ) : null}
      {rule?.mode === "constant" && !rule.sample ? (
        choices[field] ? (
          <select
            aria-label={`Value of ${labelOf(field)} for every row`}
            value={rule.value}
            onChange={(e) => onRule(field, { mode: "constant", value: e.target.value })}
            className="h-8 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-[12px]"
          >
            {choices[field]!.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label={`Value of ${labelOf(field)} for every row`}
            value={rule.value}
            maxLength={2000}
            dir="auto"
            placeholder="Type the value…"
            onChange={(e) => onRule(field, { mode: "constant", value: e.target.value })}
            className="h-8 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12px]"
          />
        )
      ) : null}
    </div>
  );
}

/** A searchable list of the file's columns (and the other ways to fill a field), operable from the keyboard. */
function ColumnPicker({ field, options, current, required, onChoose }: { field: ClientImportFieldKey; options: Option[]; current: string; required: boolean; onChoose: (o: Option) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const chosen = options.find((o) => o.key === current) ?? options[0]!;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const pick = (o: Option | undefined) => {
    if (!o) return;
    onChoose(o);
    setOpen(false);
    setQuery("");
    button.current?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(shown.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      button.current?.focus();
    }
  };
  const isColumn = current.startsWith("col:");
  const empty = current === "empty";

  return (
    <div ref={box} className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Excel column for ${labelOf(field)}: ${chosen.label}`}
        data-picker={field}
        onClick={() => {
          setOpen((o) => !o);
          setActive(Math.max(0, options.findIndex((o) => o.key === current)));
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`flex h-8 w-full items-center justify-between gap-1 rounded-[var(--radius-sm)] border px-2 text-left text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] ${
          empty && required
            ? "border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-[color:var(--color-danger-fg)]"
            : isColumn
              ? "border-[var(--color-accent)] bg-[var(--color-surface)] font-medium text-[color:var(--color-foreground)]"
              : "border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-muted-foreground)]"
        }`}
      >
        <span className="truncate">{empty ? "— Choose a column —" : chosen.label}</span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </button>
      {open ? (
        <div className="absolute left-0 top-9 z-40 w-64 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-lg)]">
          <label className="mb-1 flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2">
            <Search className="size-3.5 text-[color:var(--color-muted-foreground)]" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKey}
              placeholder="Search columns"
              aria-label="Search columns"
              aria-controls={listId}
              aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
              className="h-7 w-full bg-transparent text-[12.5px] outline-none"
            />
          </label>
          <ul id={listId} role="listbox" aria-label={`Source for ${labelOf(field)}`} className="max-h-64 overflow-y-auto">
            {shown.map((o, i) => (
              <li
                key={o.key}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={o.key === current}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o)}
                onMouseEnter={() => setActive(i)}
                className={`flex cursor-pointer items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-[12.5px] ${i === active ? "bg-[var(--color-neutral-bg)]" : ""} ${o.key.startsWith("col:") ? "" : "italic text-[color:var(--color-muted-foreground)]"}`}
              >
                <span className="truncate">{o.label}</span>
                {o.key === current ? <Check className="size-3.5 shrink-0 text-[color:var(--color-success-fg)]" aria-hidden /> : o.hint ? <span className="shrink-0 text-[10.5px] text-[color:var(--color-subtle-foreground)]">{o.hint}</span> : null}
              </li>
            ))}
            {shown.length === 0 ? <li className="px-2 py-1.5 text-[12px] text-[color:var(--color-muted-foreground)]">No column matches.</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
