"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Ban, Check, ChevronLeft, ChevronRight, Columns3, Download, EyeOff, Info, Loader2, RotateCcw, Search, ShieldAlert, Undo2, Wand2 } from "lucide-react";
import { CLIENT_DUPLICATE_POLICY_LABELS, labelOf, SMART_IDENTITY_FIELDS, SMART_FIELD_KEYS, type ClientDuplicatePolicy, type ClientImportFieldKey, type FieldIssue } from "@support-automation/shared";
import Link, { useProjectHref } from "@/components/ProjectLink";
import { Alert, Badge, Button, Card, Checkbox, Dialog, Field, Input, Select } from "@/components/ui";
import {
  bulkSetSmartField,
  confirmSmartImport,
  editSmartRow,
  loadSmartReview,
  resetSmartCell,
  resetSmartRow,
  setSmartRowsIgnored,
  type SmartReview,
  type SmartReviewRow,
} from "@/server/actions/smartImport";

/**
 * Smart Bulk Import, step 3 (SMART_IMPORT.md): every row as it will be imported, with the reason a row
 * cannot be, and a place to correct it. Pages through the rows on the server — a 5,000-row file never
 * puts 5,000 rows in the page. Corrections are saved on the server as they are made, so leaving and
 * coming back keeps them.
 */

const FILTERS: Array<{ key: string; label: string; count: (s: SmartReview["summary"]) => number }> = [
  { key: "all", label: "All", count: (s) => s.total - s.blank },
  { key: "ready", label: "Ready", count: (s) => s.ready },
  { key: "invalid", label: "Need fixing", count: (s) => s.invalid },
  { key: "match", label: "Existing clients", count: (s) => s.matchExisting },
  { key: "repeat", label: "Repeats in file", count: (s) => s.repeats },
  { key: "ignored", label: "Left out", count: (s) => s.ignored },
  { key: "edited", label: "Corrected", count: () => -1 },
];

const STATUS_BADGE: Record<SmartReviewRow["status"], { label: string; color: "green" | "yellow" | "red" | "gray" | "blue" }> = {
  NEW: { label: "New client", color: "green" },
  MATCH: { label: "Existing client", color: "blue" },
  REPEAT: { label: "Repeat", color: "yellow" },
  INVALID: { label: "Needs fixing", color: "red" },
  IGNORED: { label: "Left out", color: "gray" },
  BLANK: { label: "Empty", color: "gray" },
};

export function ReviewGrid({ jobId, onBackToMapping, onQueued }: { jobId: string; onBackToMapping: () => void; onQueued: () => void }) {
  const toProject = useProjectHref();
  const [data, setData] = useState<SmartReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [hidden, setHidden] = useState<Set<ClientImportFieldKey>>(() => readHiddenColumns());
  const [columnsOpen, setColumnsOpen] = useState(false);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    const r = await loadSmartReview(jobId, { filter, search: query, page, pageSize });
    if (id !== requestId.current) return; // a newer request is on its way; this answer is stale
    setLoading(false);
    if ("error" in r) setError(r.error);
    else {
      setError(null);
      setData(r);
      if (r.page !== page) setPage(r.page);
    }
  }, [jobId, filter, query, page, pageSize]);

  useEffect(() => {
    // Loading the page's rows is the effect's whole job; the state it sets is the server's answer.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!data) {
    return (
      <p className="flex items-center gap-2 py-10 text-sm text-[color:var(--color-muted-foreground)]">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Checking every row…
      </p>
    );
  }

  const { summary } = data;
  const fields = data.shownFields.filter((f) => !hidden.has(f));
  const setColumnHidden = (field: ClientImportFieldKey, hide: boolean) => {
    const next = new Set(hidden);
    if (hide) next.add(field);
    else next.delete(field);
    setHidden(next);
    writeHiddenColumns(next);
  };
  const pages = Math.max(1, Math.ceil(data.filteredCount / data.pageSize));
  const pageIds = data.rows.map((r) => r.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  async function act(promise: Promise<{ ok: boolean; message: string }>) {
    const r = await promise;
    setNotice(r.message);
    setSelected(new Set());
    await refresh();
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Tile label="Rows in the file" value={summary.total - summary.blank} />
        <Tile label="Ready to import" value={summary.ready} tone="success" onClick={() => (setFilter("ready"), setPage(1))} />
        <Tile label="New clients" value={summary.willCreate} tone="success" onClick={() => (setFilter("new"), setPage(1))} />
        <Tile label="Existing clients" value={summary.matchExisting} tone={summary.matchExisting ? "info" : undefined} onClick={() => (setFilter("match"), setPage(1))} />
        <Tile label="Need fixing" value={summary.invalid} tone={summary.invalid ? "danger" : undefined} onClick={() => (setFilter("invalid"), setPage(1))} />
        <Tile label="Repeats / left out" value={summary.repeats + summary.ignored} tone={summary.repeats ? "warning" : undefined} onClick={() => (setFilter("repeat"), setPage(1))} />
      </div>

      {data.assessment.blocks.map((b) => (
        <Alert key={b.code} tone="danger" title="This file cannot be imported yet">
          {b.message}{" "}
          {b.code === "NAME_UNSET" ? (
            <button type="button" className="font-medium underline underline-offset-2" onClick={onBackToMapping}>
              Open the mapping
            </button>
          ) : null}
        </Alert>
      ))}
      {notice ? <Alert tone="info">{notice}</Alert> : null}

      <Card className="overflow-hidden p-0!">
        <div className="flex flex-col gap-3 border-b border-[var(--color-border)] p-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:pb-0" role="tablist" aria-label="Show rows">
            {FILTERS.map((f) => {
              const n = f.count(summary);
              const active = filter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setFilter(f.key);
                    setPage(1);
                    setSelected(new Set());
                  }}
                  className={`shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium transition-colors ${active ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]" : "bg-[var(--color-neutral-bg)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"}`}
                >
                  {f.label}
                  {n >= 0 ? <span className="ml-1.5 tabular opacity-80">{n.toLocaleString()}</span> : null}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <label className="relative block flex-1 lg:w-64">
              <span className="sr-only">Search rows</span>
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[color:var(--color-muted-foreground)]" aria-hidden />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, phone, row…" className="w-full pl-8" />
            </label>
            <div className="relative">
              <Button size="sm" variant="secondary" onClick={() => setColumnsOpen((v) => !v)} aria-expanded={columnsOpen}>
                <Columns3 className="size-3.5" aria-hidden />
                Columns{hidden.size ? ` (${data.shownFields.length - hidden.size}/${data.shownFields.length})` : ""}
              </Button>
              {columnsOpen ? (
                <div className="absolute right-0 top-full z-20 mt-1 max-h-80 w-60 overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-raised,var(--color-surface))] p-2 shadow-[var(--shadow-lg)]">
                  <p className="px-1.5 pb-1.5 text-[11.5px] text-[color:var(--color-muted-foreground)]">Every field is imported whether shown or not. Hiding only tidies this view.</p>
                  {data.shownFields.map((f) => (
                    <label key={f} className="flex items-center gap-2 rounded px-1.5 py-1 text-[12.5px] hover:bg-[var(--color-neutral-bg)]">
                      <Checkbox checked={!hidden.has(f)} onChange={(e) => setColumnHidden(f, !e.target.checked)} />
                      {labelOf(f)}
                    </label>
                  ))}
                  {hidden.size ? (
                    <button type="button" className="mt-1 w-full rounded px-1.5 py-1 text-left text-[12px] font-medium text-[color:var(--color-accent-fg,var(--color-accent))] hover:underline" onClick={() => (setHidden(new Set()), writeHiddenColumns(new Set()))}>
                      Show every column
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
            {loading ? <Loader2 className="size-4 animate-spin text-[color:var(--color-muted-foreground)]" aria-label="Loading" /> : null}
          </div>
        </div>

        {selected.size ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-accent)]/[0.06] px-3 py-2 text-[12.5px]">
            <span className="font-medium">{selected.size} selected</span>
            <Button size="sm" variant="secondary" onClick={() => act(setSmartRowsIgnored(jobId, { rowIds: [...selected] }, true))}>
              <EyeOff className="size-3.5" aria-hidden />
              Leave out
            </Button>
            <Button size="sm" variant="secondary" onClick={() => act(setSmartRowsIgnored(jobId, { rowIds: [...selected] }, false))}>
              <Undo2 className="size-3.5" aria-hidden />
              Bring back
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        ) : null}

        <div className="max-h-[70vh] overflow-auto" data-review-grid>
          <table className="w-max min-w-full border-separate border-spacing-0 text-[13px]">
            <thead className="sticky top-0 z-[3] bg-[var(--color-surface)]">
              <tr className="text-left text-[11.5px] uppercase tracking-wide text-[color:var(--color-muted-foreground)] [&>th]:border-b [&>th]:border-[var(--color-border)] [&>th]:bg-[var(--color-surface)]">
                <th className="sticky left-0 z-[2] w-10 px-3 py-2">
                  <Checkbox
                    aria-label="Select the rows on this page"
                    checked={allOnPage}
                    onChange={(e) => setSelected((s) => new Set(e.target.checked ? [...s, ...pageIds] : [...s].filter((id) => !pageIds.includes(id))))}
                  />
                </th>
                <th className="sticky left-10 z-[2] w-14 px-2 py-2 font-semibold">Row</th>
                <th className="sticky left-24 z-[2] w-32 px-2 py-2 font-semibold shadow-[1px_0_0_var(--color-border)]">Result</th>
                {fields.map((f) => (
                  <th key={f} className={`px-2 py-2 font-semibold ${WIDE.has(f) ? "min-w-56" : "min-w-36"}`}>
                    {labelOf(f)}
                  </th>
                ))}
                {data.rows.some((r) => r.money) ? <th className="min-w-56 px-2 py-2 font-semibold">Amounts (recorded only)</th> : null}
                <th className="w-20 px-2 py-2" aria-label="Row actions" />
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? (
                <tr>
                  <td colSpan={fields.length + 4} className="px-4 py-10 text-center text-[color:var(--color-muted-foreground)]">
                    No rows here.
                  </td>
                </tr>
              ) : (
                data.rows.map((row, index) => (
                  <ReviewRow
                    key={row.id}
                    index={index}
                    jobId={jobId}
                    row={row}
                    fields={fields}
                    showMoney={data.rows.some((r) => r.money)}
                    selected={selected.has(row.id)}
                    onSelect={(on) => setSelected((s) => (on ? new Set([...s, row.id]) : new Set([...s].filter((id) => id !== row.id))))}
                    onChanged={refresh}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] px-3 py-2.5 text-[12.5px]">
          <div className="flex items-center gap-2">
            <span className="text-[color:var(--color-muted-foreground)]">
              {data.filteredCount.toLocaleString()} row{data.filteredCount === 1 ? "" : "s"}
            </span>
            <Select value={String(pageSize)} onChange={(e) => (setPageSize(Number(e.target.value)), setPage(1))} aria-label="Rows per page" className="h-8 w-auto text-[12.5px]">
              {[25, 50, 100, 250, 500, 1000].map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString("en-US")} per page
                </option>
              ))}
            </Select>
            <Button size="sm" variant="ghost" onClick={() => setBulkOpen(true)} disabled={data.filteredCount === 0}>
              <Wand2 className="size-3.5" aria-hidden />
              Set a field for these rows…
            </Button>
          </div>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="secondary" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)} aria-label="Previous page">
              <ChevronLeft className="size-4" aria-hidden />
            </Button>
            <span className="px-2 tabular">
              Page {data.page} of {pages}
            </span>
            <Button size="sm" variant="secondary" disabled={data.page >= pages} onClick={() => setPage(data.page + 1)} aria-label="Next page">
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
      </Card>

      {bulkOpen ? (
        <BulkSetDialog
          count={data.filteredCount}
          filterLabel={FILTERS.find((f) => f.key === filter)?.label ?? "these"}
          onClose={() => setBulkOpen(false)}
          onApply={async (field, value) => {
            const r = await bulkSetSmartField(jobId, { filter, search: query }, field, value, data.filteredCount);
            if (r.ok) setBulkOpen(false);
            setNotice(r.message);
            await refresh();
            return r;
          }}
        />
      ) : null}

      <ConfirmPanel
        jobId={jobId}
        data={data}
        problemsHref={summary.invalid ? toProject(`/api/clients/import/${jobId}/problems`) : null}
        onBackToMapping={onBackToMapping}
        onQueued={onQueued}
        onStale={refresh}
      />
    </div>
  );
}

function Tile({ label, value, tone, onClick }: { label: string; value: number; tone?: "success" | "danger" | "warning" | "info"; onClick?: () => void }) {
  const color = tone === "success" ? "text-[color:var(--color-success-fg)]" : tone === "danger" ? "text-[color:var(--color-danger-fg)]" : tone === "warning" ? "text-[color:var(--color-warning-fg)]" : tone === "info" ? "text-[color:var(--color-info-fg)]" : "";
  const body = (
    <>
      <span className="block text-[11.5px] font-medium text-[color:var(--color-muted-foreground)]">{label}</span>
      <span className={`mt-1 block text-[22px] font-semibold tabular leading-none ${color}`}>{value.toLocaleString()}</span>
    </>
  );
  const shell = "rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-left shadow-[var(--shadow-xs)]";
  return onClick ? (
    <button type="button" onClick={onClick} className={`${shell} transition-[border-color,transform] hover:-translate-y-px hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]`}>
      {body}
    </button>
  ) : (
    <div className={shell}>{body}</div>
  );
}

const WIDE = new Set<ClientImportFieldKey>(["name", "company", "email", "address", "note", "service"]);
const DATE_FIELDS = new Set<ClientImportFieldKey>(["startDate", "expiryDate"]);
const HIDDEN_KEY = "smart-import-hidden-columns";

function readHiddenColumns(): Set<ClientImportFieldKey> {
  try {
    if (typeof window === "undefined") return new Set();
    const raw = JSON.parse(window.localStorage.getItem(HIDDEN_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? (raw.filter((k) => (SMART_FIELD_KEYS as readonly string[]).includes(k)) as ClientImportFieldKey[]) : []);
  } catch {
    return new Set();
  }
}
function writeHiddenColumns(hidden: Set<ClientImportFieldKey>) {
  try {
    window.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
  } catch {
    // a private window: the choice simply is not remembered
  }
}

/** Moves focus between cells with the arrow keys (the grid is a table of buttons). */
function moveFocus(from: HTMLElement, key: string) {
  const [r, c] = (from.dataset.cell ?? "").split(":").map(Number) as [number, number];
  const target = key === "ArrowRight" ? [r, c + 1] : key === "ArrowLeft" ? [r, c - 1] : key === "ArrowDown" ? [r + 1, c] : [r - 1, c];
  const next = from.closest("[data-review-grid]")?.querySelector<HTMLElement>(`[data-cell="${target[0]}:${target[1]}"]`);
  if (next) {
    next.focus();
    next.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function ReviewRow({
  index,
  jobId,
  row,
  fields,
  showMoney,
  selected,
  onSelect,
  onChanged,
}: {
  index: number;
  jobId: string;
  row: SmartReviewRow;
  fields: ClientImportFieldKey[];
  showMoney: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const badge = STATUS_BADGE[row.status];
  const muted = row.status === "IGNORED" || row.status === "REPEAT";
  const errors = row.issues.filter((i) => i.severity === "error");
  // Problems on a column that is hidden still need to be seen: they are listed under the row.
  const listed = row.status === "INVALID" ? (errors.length ? errors : row.errors.map((message) => ({ field: "name" as ClientImportFieldKey, severity: "error" as const, message }))) : [];
  const sticky = "sticky z-[1] bg-[var(--color-surface)]";
  return (
    <>
      <tr className={`align-top [&>td]:border-b [&>td]:border-[var(--color-border)] ${muted ? "opacity-70" : ""}`}>
        <td className={`${sticky} left-0 px-3 py-2`}>
          <Checkbox aria-label={`Select row ${row.rowNumber}`} checked={selected} onChange={(e) => onSelect(e.target.checked)} />
        </td>
        <td className={`${sticky} left-10 px-2 py-2 tabular text-[color:var(--color-muted-foreground)]`}>{row.rowNumber}</td>
        <td className={`${sticky} left-24 px-2 py-2 shadow-[1px_0_0_var(--color-border)]`}>
          <Badge color={badge.color}>{badge.label}</Badge>
          {row.status === "MATCH" && row.matchedClientId ? (
            <Link href={`/clients/${row.matchedClientId}`} className="mt-1 block text-[11px] underline underline-offset-2" target="_blank">
              Open client
            </Link>
          ) : null}
          {row.status === "REPEAT" ? <span className="mt-1 block text-[11px] text-[color:var(--color-muted-foreground)]">Same client as row {row.repeatsRow}</span> : null}
        </td>
        {fields.map((f, col) => (
          <EditableCell
            key={f}
            cell={`${index}:${col}`}
            jobId={jobId}
            rowId={row.id}
            field={f}
            value={row.values[f] ?? ""}
            edited={row.edited.includes(f)}
            issues={row.issues.filter((i) => i.field === f)}
            note={
              f === "expiryDate"
                ? (row.expiryBasis ?? null)
                : f === "country" || f === "currency" || f === "language"
                  ? row.derived[f]
                    ? `Auto selected: ${row.derived[f]} (from the ${f === "country" ? "phone number" : "country"})`
                    : null
                  : f === "phone" || f === "whatsapp"
                    ? (row.phoneNotes.find((n) => n.field === f)?.note ?? null)
                    : null
            }
            disabled={row.status === "IGNORED"}
            onSaved={onChanged}
          />
        ))}
        {showMoney ? <MoneyCell money={row.money} /> : null}
        <td className="whitespace-nowrap px-2 py-2 text-right">
          {row.status === "IGNORED" ? (
            <IconButton label={`Bring back row ${row.rowNumber}`} onClick={async () => (await setSmartRowsIgnored(jobId, { rowIds: [row.id] }, false), await onChanged())}>
              <Undo2 className="size-3.5" aria-hidden />
            </IconButton>
          ) : (
            <IconButton label={`Leave out row ${row.rowNumber}`} onClick={async () => (await setSmartRowsIgnored(jobId, { rowIds: [row.id] }, true), await onChanged())}>
              <Ban className="size-3.5" aria-hidden />
            </IconButton>
          )}
          {row.edited.length ? (
            <IconButton label={`Undo every correction on row ${row.rowNumber}`} onClick={async () => (await resetSmartRow(jobId, row.id), await onChanged())}>
              <RotateCcw className="size-3.5" aria-hidden />
            </IconButton>
          ) : null}
        </td>
      </tr>
      {listed.length ? (
        <tr className="[&>td]:border-b [&>td]:border-[var(--color-border)]">
          <td className={`${sticky} left-0`} />
          <td colSpan={fields.length + (showMoney ? 4 : 3)} className="px-2 pb-2.5 pt-0">
            <ul className="sticky left-24 w-fit max-w-[min(42rem,calc(100vw-8rem))] space-y-0.5 text-[12px] text-[color:var(--color-danger-fg)]">
              {listed.map((e, i) => (
                <li key={i} className="flex gap-1.5">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                  <span>
                    <strong className="font-medium">{labelOf(e.field)}:</strong> {e.message}
                  </span>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      ) : null}
    </>
  );
}

const ISSUE_STYLE: Record<FieldIssue["severity"], string> = {
  error: "bg-[var(--color-danger-bg)] ring-1 ring-inset ring-[var(--color-danger-border)]",
  warning: "bg-[var(--color-warning-bg)] ring-1 ring-inset ring-[var(--color-warning-border)]",
  info: "",
};

/**
 * One field of one row. Click or Enter edits; Enter or leaving the box saves; Escape cancels; the arrow
 * keys move between cells. Only THIS cell is coloured by its own problem: red for an error, amber for a
 * warning, nothing for an empty optional field.
 */
function EditableCell({
  cell,
  jobId,
  rowId,
  field,
  value,
  edited,
  issues,
  note,
  disabled,
  onSaved,
}: {
  cell: string;
  jobId: string;
  rowId: string;
  field: ClientImportFieldKey;
  value: string;
  edited: boolean;
  issues: FieldIssue[];
  note: string | null;
  disabled: boolean;
  onSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const cancelled = useRef(false);
  const severity: FieldIssue["severity"] | null = issues.some((i) => i.severity === "error") ? "error" : issues.some((i) => i.severity === "warning") ? "warning" : null;
  const tooltip = [...issues.map((i) => i.message), note && !issues.length ? note : null, disabled ? null : "Click or press Enter to correct"].filter(Boolean).join("\n");
  const asDate = DATE_FIELDS.has(field) && (!draft || /^\d{4}-\d{2}-\d{2}$/.test(draft));

  async function commit() {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    setEditing(false);
    if (draft === value) return;
    setState("saving");
    const r = await editSmartRow(jobId, rowId, field, draft);
    if (!r.ok) {
      setState("error");
      setProblem(r.message);
      return;
    }
    setState("idle");
    setProblem(r.message !== "Saved." ? r.message : null);
    await onSaved();
  }

  if (editing) {
    return (
      <td className="px-1.5 py-1.5">
        <div className="flex items-center gap-1">
          <Input
            autoFocus
            type={asDate ? "date" : "text"}
            value={draft}
            dir="auto"
            aria-label={`${labelOf(field)}, row value`}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              } else if (e.key === "Escape") {
                cancelled.current = true;
                setDraft(value);
                setEditing(false);
              }
            }}
            className="h-8 w-full min-w-32 text-[13px]"
          />
          {edited ? (
            <button
              type="button"
              title="Back to the mapped value"
              aria-label={`Undo the correction to ${labelOf(field)}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={async () => {
                cancelled.current = true;
                setEditing(false);
                setState("saving");
                await resetSmartCell(jobId, rowId, field);
                setState("idle");
                await onSaved();
              }}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)]"
            >
              <Undo2 className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
      </td>
    );
  }
  return (
    <td className="px-1 py-1">
      <button
        type="button"
        data-cell={cell}
        disabled={disabled}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        onKeyDown={(e) => {
          if (e.key.startsWith("Arrow")) {
            e.preventDefault();
            moveFocus(e.currentTarget, e.key);
          }
        }}
        title={tooltip}
        aria-invalid={severity === "error" || undefined}
        className={`group flex min-h-8 w-full items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 py-1 text-left transition-colors hover:brightness-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] disabled:cursor-default ${severity ? ISSUE_STYLE[severity] : "hover:bg-[var(--color-neutral-bg)]"} ${state === "error" ? "ring-1 ring-[var(--color-danger)]" : ""}`}
      >
        <span className={`min-w-0 flex-1 truncate ${value ? (severity === "error" ? "text-[color:var(--color-danger-fg)]" : "") : "text-[color:var(--color-muted-foreground)]/60"}`} dir="auto">
          {value || "—"}
        </span>
        {severity === "error" ? <AlertTriangle className="size-3 shrink-0 text-[color:var(--color-danger-fg)]" aria-hidden /> : null}
        {severity === "warning" ? <Info className="size-3 shrink-0 text-[color:var(--color-warning-fg)]" aria-hidden /> : null}
        {state === "saving" ? <Loader2 className="size-3 shrink-0 animate-spin" aria-label="Saving" /> : null}
        {edited && state !== "saving" ? <span className="size-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" aria-label="Corrected" title="Corrected on this screen" /> : null}
      </button>
      {note && field === "expiryDate" && value ? <span className="block max-w-56 truncate px-1.5 text-[10.5px] text-[color:var(--color-muted-foreground)]" title={note}>{note}</span> : null}
      {problem ? <span className="block max-w-56 px-1.5 text-[11px] text-[color:var(--color-warning-fg)]">{problem}</span> : null}
    </td>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void | Promise<unknown>; children: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
      className="inline-flex size-7 items-center justify-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] disabled:opacity-40"
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : children}
    </button>
  );
}

function BulkSetDialog({ count, filterLabel, onClose, onApply }: { count: number; filterLabel: string; onClose: () => void; onApply: (field: ClientImportFieldKey, value: string) => Promise<{ ok: boolean; message: string }> }) {
  const allowed = SMART_FIELD_KEYS.filter((f) => !(SMART_IDENTITY_FIELDS as readonly string[]).includes(f));
  const [field, setField] = useState<ClientImportFieldKey>("category");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Set a field on ${count.toLocaleString()} row${count === 1 ? "" : "s"}`}
      description={`Every row in "${filterLabel}" gets this value, replacing what the file or an earlier correction gave it. Each row is checked again afterwards.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              const r = await onApply(field, value);
              setBusy(false);
              if (!r.ok) setError(r.message);
            }}
          >
            Set on {count.toLocaleString()} row{count === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Field label="Field" htmlFor="bulk-field" hint="Fields that identify a client (phone, email, code…) cannot be set for many rows at once.">
          <Select id="bulk-field" value={field} onChange={(e) => setField(e.target.value as ClientImportFieldKey)} className="w-full">
            {allowed.map((f) => (
              <option key={f} value={f}>
                {labelOf(f)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Value" htmlFor="bulk-value" hint="Leave empty to clear this field on these rows.">
          <Input id="bulk-value" value={value} onChange={(e) => setValue(e.target.value)} maxLength={2000} dir="auto" />
        </Field>
      </div>
    </Dialog>
  );
}

function ConfirmPanel({ jobId, data, problemsHref, onBackToMapping, onQueued, onStale }: { jobId: string; data: SmartReview; problemsHref: string | null; onBackToMapping: () => void; onQueued: () => void; onStale: () => Promise<void> }) {
  const [policy, setPolicy] = useState<ClientDuplicatePolicy>("SKIP");
  const [acks, setAcks] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { summary, assessment } = data;
  const blocked = assessment.blocks.length > 0;
  const unacked = assessment.warnings.filter((w) => !acks.has(w.code));
  const willWrite = summary.willCreate + (policy === "SKIP" ? 0 : summary.matchExisting);

  return (
    <Card className="space-y-4 p-5!">
      <h3 className="text-[15px] font-semibold">Ready to import?</h3>
      {assessment.warnings.length ? (
        <div className="space-y-2">
          {assessment.warnings.map((w) => (
            <label key={w.code} className="flex items-start gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] p-3 text-[13px]">
              <Checkbox checked={acks.has(w.code)} onChange={(e) => setAcks((s) => (e.target.checked ? new Set([...s, w.code]) : new Set([...s].filter((c) => c !== w.code))))} />
              <span>
                <span className="flex items-center gap-1.5 font-medium text-[color:var(--color-warning-fg)]">
                  <ShieldAlert className="size-3.5" aria-hidden />
                  {w.message}
                </span>
                <span className="text-[12px] text-[color:var(--color-muted-foreground)]">Tick to confirm you have checked this.</span>
              </span>
            </label>
          ))}
        </div>
      ) : null}

      {summary.matchExisting > 0 ? (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[13px] font-medium">{summary.matchExisting.toLocaleString()} row(s) match a client you already have</legend>
          {(["SKIP", "UPDATE", "CREATE"] as const).map((p) => (
            <label key={p} className="flex items-start gap-2 text-[13px]">
              <input type="radio" name="policy" value={p} checked={policy === p} onChange={() => setPolicy(p)} className="mt-0.5 accent-[var(--color-accent)]" />
              <span>{CLIENT_DUPLICATE_POLICY_LABELS[p]}</span>
            </label>
          ))}
        </fieldset>
      ) : null}

      <ul className="space-y-1 text-[13px] text-[color:var(--color-muted-foreground)]">
        <li className="flex items-center gap-1.5">
          <Check className="size-3.5 text-[color:var(--color-success)]" aria-hidden />
          {summary.willCreate.toLocaleString()} new client{summary.willCreate === 1 ? "" : "s"} will be created
          {summary.matchExisting && policy !== "SKIP" ? `, ${summary.matchExisting.toLocaleString()} existing ${policy === "UPDATE" ? "updated" : "created again"}` : ""}.
        </li>
        {summary.invalid ? <li>{summary.invalid.toLocaleString()} row(s) that need fixing will NOT be imported.</li> : null}
        {summary.repeats ? <li>{summary.repeats.toLocaleString()} repeat(s) of an earlier row will be skipped.</li> : null}
        {summary.subscriptionRows ? <li>{summary.subscriptionRows.toLocaleString()} row(s) carry a subscription; it is added only if you may sell subscriptions.</li> : null}
        <li>The import runs in the background. You can leave this page and come back.</li>
      </ul>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onBackToMapping}>
            <ArrowLeft className="size-4" aria-hidden />
            Back to mapping
          </Button>
          {problemsHref ? (
            <a href={problemsHref} download className="inline-flex h-9.5 items-center gap-2 rounded-[var(--radius-md)] px-3 text-sm font-medium text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)]">
              <Download className="size-4" aria-hidden />
              Download rows that need fixing
            </a>
          ) : null}
        </div>
        <Button
          loading={busy}
          disabled={blocked || unacked.length > 0 || willWrite === 0}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const r = await confirmSmartImport(jobId, { revision: data.revision, policy, acknowledged: [...acks] });
            setBusy(false);
            if (r.ok) onQueued();
            else {
              setError(r.message);
              await onStale();
            }
          }}
        >
          Import {willWrite.toLocaleString()} client{willWrite === 1 ? "" : "s"}
        </Button>
      </div>
    </Card>
  );
}

/**
 * The amounts a row states (V5 §7), as recorded on the client: each in its own currency, never added up, never an
 * invoice. Several currencies or an unreadable cell are shown with the reason and need acknowledging at import.
 */
function MoneyCell({ money }: { money: SmartReviewRow["money"] }) {
  if (!money || money.status === "NONE") return <td className="px-2 py-2 text-[color:var(--color-subtle-foreground)]">—</td>;
  if (money.status === "ZERO") return <td className="px-2 py-2 text-[12px] text-[color:var(--color-muted-foreground)]">Zero — nothing recorded</td>;
  return (
    <td className="px-2 py-2 text-[12.5px]" data-money={money.status}>
      <ul className="space-y-0.5">
        {money.amounts.map((a, i) => (
          <li key={i} className={a.problem ? "text-[color:var(--color-danger-fg)]" : ""} title={a.problem ?? `From the ${a.column} column`}>
            {a.amount && a.currency ? (
              <span className="tabular-nums">
                {a.currency} {a.amount}
              </span>
            ) : (
              <span>&ldquo;{a.original.trim()}&rdquo;</span>
            )}
            {a.problem ? <span className="block text-[11px]">{a.problem}</span> : null}
          </li>
        ))}
      </ul>
      {money.status === "MULTIPLE" ? <span className="mt-0.5 block text-[11px] text-[color:var(--color-warning-fg)]">Several currencies — each kept separately</span> : null}
    </td>
  );
}
