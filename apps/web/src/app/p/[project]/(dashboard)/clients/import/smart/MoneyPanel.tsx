"use client";

import { Banknote, Columns3, Plus, Trash2, Wand2 } from "lucide-react";
import { describeAmounts, detectMoneyColumns, ISO_CURRENCY_CODES, readRowMoney, SMART_KEEP_COLUMNS_MAX, type SmartMoneyMapping } from "@support-automation/shared";
import { Button, Card } from "@/components/ui";
import { currencyName } from "@/lib/clientLocale";
import type { PreviewSourceRow } from "@/lib/smartMappingPreview";

/**
 * Amounts and unmapped columns in the Advanced Mapping (Smart Import V5 §7, §11). Part of the same mapping the
 * grid edits: amounts are read row by row and kept on each client exactly as written — never an invoice, a
 * receipt, a due or a payment, never converted or added across currencies. A column no field reads can be kept
 * as a custom field, so nothing in the file is dropped without the person deciding it.
 */
export function MoneyPanel({
  headers,
  unused,
  previewRows,
  money,
  keepColumns,
  onMoney,
  onKeep,
}: {
  headers: readonly string[];
  /** Columns no field reads (candidates to keep). */
  unused: readonly string[];
  previewRows: readonly PreviewSourceRow[];
  money: SmartMoneyMapping | undefined;
  keepColumns: readonly string[];
  onMoney: (money: SmartMoneyMapping | undefined) => void;
  onKeep: (columns: string[]) => void;
}) {
  const found = detectMoneyColumns(headers);
  const sure = found.filter((f) => f.currency);
  const mode = money?.mode ?? "NONE";
  const currencySelect = (value: string, onChange: (v: string) => void, label: string, extra?: readonly string[]) => (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="h-8 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-[12.5px]">
      <option value="">{extra?.length ? `Which? (${extra.join(", ")})` : "Currency…"}</option>
      {[...(extra ?? []), ...ISO_CURRENCY_CODES.filter((c) => !extra?.includes(c))].map((c) => (
        <option key={c} value={c}>
          {c} — {currencyName(c)}
        </option>
      ))}
    </select>
  );

  return (
    <Card className="space-y-4 p-4!" data-money-panel>
      <div>
        <h3 className="flex items-center gap-2 text-[13.5px] font-semibold">
          <Banknote className="size-4 text-[color:var(--color-muted-foreground)]" aria-hidden />
          Amounts in this file
        </h3>
        <p className="mt-0.5 text-[12px] text-[color:var(--color-muted-foreground)]">
          Recorded on each client exactly as written, in its own currency. No invoice, receipt, due or payment is created, and nothing is converted or added together.
        </p>
      </div>

      <div role="radiogroup" aria-label="How amounts are laid out" className="flex flex-wrap gap-1.5">
        {(
          [
            ["NONE", "No amounts"],
            ["SINGLE", "One amount column + its currency"],
            ["MULTI", "One column per currency"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={mode === key}
            onClick={() =>
              onMoney(
                key === "NONE"
                  ? undefined
                  : key === "SINGLE"
                    ? { mode: "SINGLE", amountColumn: money?.mode === "SINGLE" ? money.amountColumn : "", currencyColumn: money?.mode === "SINGLE" ? money.currencyColumn : undefined }
                    : { mode: "MULTI", columns: money?.mode === "MULTI" ? money.columns : sure.map((f) => ({ column: f.column, currency: f.currency! })) },
              )
            }
            className={`rounded-[var(--radius-md)] border px-3 py-1.5 text-[12.5px] ${mode === key ? "border-[var(--color-accent)] bg-[var(--color-surface)] font-medium" : "border-[var(--color-border)] text-[color:var(--color-muted-foreground)]"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "NONE" && found.length ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-info-border)] bg-[var(--color-info-bg)] px-3 py-2 text-[12.5px] text-[color:var(--color-info-fg)]">
          <Wand2 className="size-4" aria-hidden />
          These columns look like currencies: {found.map((f) => (f.currency ? `${f.column} (${f.currency})` : `${f.column} (?)`)).join(", ")}.
          <Button size="sm" variant="secondary" onClick={() => onMoney({ mode: "MULTI", columns: found.map((f) => ({ column: f.column, currency: f.currency ?? "" })) })}>
            Use them
          </Button>
        </div>
      ) : null}

      {money?.mode === "SINGLE" ? (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
          Amount column
          <select aria-label="Amount column" value={money.amountColumn} onChange={(e) => onMoney({ ...money, amountColumn: e.target.value })} className="h-8 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5">
            <option value="">Choose…</option>
            {headers.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
          currency from
          <select
            aria-label="Currency column"
            value={money.currencyColumn ?? ""}
            onChange={(e) => onMoney({ mode: "SINGLE", amountColumn: money.amountColumn, ...(e.target.value ? { currencyColumn: e.target.value } : {}), ...(money.currency ? { currency: money.currency } : {}) })}
            className="h-8 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5"
          >
            <option value="">— no column —</option>
            {headers.map((h) => (
              <option key={h} value={h}>
                column {h}
              </option>
            ))}
          </select>
          {money.currencyColumn ? "or, when that cell is empty," : "always"}
          {currencySelect(money.currency ?? "", (v) => onMoney({ mode: "SINGLE", amountColumn: money.amountColumn, ...(money.currencyColumn ? { currencyColumn: money.currencyColumn } : {}), ...(v ? { currency: v } : {}) }), "Fixed currency")}
        </div>
      ) : null}

      {money?.mode === "MULTI" ? (
        <div className="space-y-1.5">
          {money.columns.map((c, i) => {
            const hint = found.find((f) => f.column === c.column);
            return (
              <div key={i} className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <select
                  aria-label={`Amount column ${i + 1}`}
                  value={c.column}
                  onChange={(e) => onMoney({ mode: "MULTI", columns: money.columns.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)) })}
                  className="h-8 min-w-36 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5"
                >
                  <option value="">Column…</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
                holds
                {currencySelect(c.currency, (v) => onMoney({ mode: "MULTI", columns: money.columns.map((x, j) => (j === i ? { ...x, currency: v } : x)) }), `Currency of ${c.column || `column ${i + 1}`}`, hint?.ambiguous)}
                {hint?.ambiguous && !c.currency ? <span className="text-[11.5px] text-[color:var(--color-warning-fg)]">&ldquo;{c.column}&rdquo; can mean several currencies — choose one.</span> : null}
                <Button size="sm" variant="ghost" aria-label={`Remove ${c.column || "this column"}`} onClick={() => onMoney({ mode: "MULTI", columns: money.columns.filter((_, j) => j !== i) })}>
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </div>
            );
          })}
          <Button size="sm" variant="secondary" onClick={() => onMoney({ mode: "MULTI", columns: [...money.columns, { column: "", currency: "" }] })}>
            <Plus className="size-3.5" aria-hidden /> Add a currency column
          </Button>
        </div>
      ) : null}

      {money ? (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)]">
          <p className="border-b border-[var(--color-border)] bg-[var(--color-neutral-bg)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">What each row records</p>
          <ul className="divide-y divide-[var(--color-border)] text-[12.5px]">
            {previewRows.map((r) => {
              const read = readRowMoney(r.cells, money);
              return (
                <li key={r.rowNumber} className="flex gap-3 px-3 py-1.5" data-money-row={r.rowNumber}>
                  <span className="w-14 shrink-0 tabular-nums text-[color:var(--color-muted-foreground)]">Row {r.rowNumber}</span>
                  <span className={read.status === "PROBLEM" ? "text-[color:var(--color-danger-fg)]" : read.status === "MULTIPLE" ? "text-[color:var(--color-warning-fg)]" : ""}>
                    {read.status === "NONE" ? "—" : read.status === "ZERO" ? "Zero — nothing recorded" : describeAmounts(read.amounts)}
                    {read.status === "MULTIPLE" ? " (several currencies — kept separately; you confirm this before importing)" : ""}
                    {read.status === "PROBLEM" ? ` — ${read.amounts.find((a) => a.problem)?.problem}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {unused.length ? (
        <div className="space-y-1.5 border-t border-[var(--color-border)] pt-3">
          <h4 className="flex items-center gap-2 text-[13px] font-semibold">
            <Columns3 className="size-4 text-[color:var(--color-muted-foreground)]" aria-hidden />
            Columns no field reads
          </h4>
          <p className="text-[12px] text-[color:var(--color-muted-foreground)]">Tick a column to keep it on each client as a custom field with the same name; the others are not imported.</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {unused.map((c) => (
              <label key={c} className="flex items-center gap-1.5 text-[12.5px]">
                <input
                  type="checkbox"
                  checked={keepColumns.includes(c)}
                  disabled={!keepColumns.includes(c) && keepColumns.length >= SMART_KEEP_COLUMNS_MAX}
                  onChange={(e) => onKeep(e.target.checked ? [...keepColumns, c] : keepColumns.filter((x) => x !== c))}
                />
                {c}
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
