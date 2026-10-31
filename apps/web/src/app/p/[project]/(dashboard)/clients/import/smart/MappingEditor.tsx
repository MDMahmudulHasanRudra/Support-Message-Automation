"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ArrowRight, Bookmark, Check, Columns3, KeyRound, LayoutList, Lightbulb, Loader2, Table2, Trash2, Wand2 } from "lucide-react";
import {
  CLIENT_IMPORT_FIELDS,
  CLIENT_STATUSES,
  CLIENT_STATUS_LABELS,
  columnUsage,
  labelOf,
  SMART_FIELD_GROUPS,
  SMART_IDENTITY_FIELDS,
  SMART_ROSTER_FIELDS,
  type ClientImportFieldKey,
  type SmartExpiryOptions,
  type SmartFieldRule,
  type SmartMapping,
  type SmartRuleKey,
} from "@support-automation/shared";
import { ExpiryPanel } from "./ExpiryPanel";
import { MappingGrid } from "./MappingGrid";
import { MoneyPanel } from "./MoneyPanel";
import { mappingToSave, readMappingView, subscribeMappingView, writeMappingView, type MappingView } from "./mappingView";
import { Alert, Badge, Button, Card, Checkbox, Input, Select } from "@/components/ui";
import {
  applySmartPreset,
  deleteSmartPreset,
  listSmartPresets,
  loadSmartMappingContext,
  saveSmartMapping,
  saveSmartPreset,
  type SmartMappingContext,
  type SmartPreset,
} from "@/server/actions/smartImport";

/**
 * Smart Bulk Import, step 2 (SMART_IMPORT.md): where each client field comes from. The application owns
 * the fields; the file only offers columns. A column may feed several fields, and nothing uncertain is
 * applied by itself — a "looks like" match is a suggestion with a button.
 */

type Mode = "source" | "constant" | "sample" | "empty";
const MODE_LABELS: Record<Mode, string> = { source: "From file", constant: "Same value", sample: "Sample", empty: "Leave empty" };

/** Fields whose fixed value is one of a known list — offered as a choice rather than typed. */
const CHOICES: Partial<Record<ClientImportFieldKey, Array<{ value: string; label: string }>>> = {
  status: CLIENT_STATUSES.filter((s) => s !== "ARCHIVED").map((s) => ({ value: s, label: CLIENT_STATUS_LABELS[s] })),
  subscriptionType: ["Paid", "Trial", "Demo", "Complimentary"].map((v) => ({ value: v, label: v })),
  durationUnit: ["Days", "Weeks", "Months", "Years"].map((v) => ({ value: v, label: v })),
};

const FIELD_HINTS: Partial<Record<ClientImportFieldKey, string>> = {
  name: "Required. Every client needs a name — a number is fine if that is all you have.",
  phone: "Several numbers in one cell can be separated by ; — the first is primary.",
  code: "Leave empty for new clients: a code is made for each one.",
  startDate: "2026-10-17, 17/10/2026 or 17 Oct 2026 (day first).",
  expiryDate: "A full date. For separate year / month / day columns, or month + year, use the Expiry panel below.",
  team: "Must match a team in this project.",
  soldBy: "A team member's name or phone number.",
  assignedTo: "A team member's name or phone number.",
};

function modeOf(rule: SmartFieldRule | undefined): Mode {
  if (!rule) return "empty";
  if (rule.mode === "constant" && rule.sample) return "sample";
  return rule.mode;
}

export function MappingEditor({ jobId, onSaved }: { jobId: string; onSaved: (revision: number) => void }) {
  const [ctx, setCtx] = useState<SmartMappingContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<SmartMapping>({ version: 2, fields: {} });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "danger" | "success" | "info"; text: string } | null>(null);
  const [presets, setPresets] = useState<SmartPreset[]>([]);

  async function load() {
    const [c, p] = await Promise.all([loadSmartMappingContext(jobId), listSmartPresets()]);
    if ("error" in c) {
      setLoadError(c.error);
      return;
    }
    setCtx(c);
    setMapping(c.mapping);
    setPresets(p);
    setDirty(false);
  }
  useEffect(() => {
    let live = true;
    void Promise.all([loadSmartMappingContext(jobId), listSmartPresets()]).then(([c, p]) => {
      if (!live) return;
      if ("error" in c) setLoadError(c.error);
      else {
        setCtx(c);
        setMapping(c.mapping);
        setPresets(p);
      }
    });
    return () => {
      live = false;
    };
  }, [jobId]);

  const usage = useMemo(() => columnUsage(mapping), [mapping]);
  const view = useSyncExternalStore(subscribeMappingView, readMappingView, () => "grid" as MappingView);

  if (loadError) return <Alert tone="danger">{loadError}</Alert>;
  if (!ctx) {
    return (
      <p className="flex items-center gap-2 py-10 text-sm text-[color:var(--color-muted-foreground)]">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Reading your columns…
      </p>
    );
  }

  const setRule = (field: SmartRuleKey, rule: SmartFieldRule | undefined) => {
    setMapping((m) => {
      const fields = { ...m.fields };
      if (rule) fields[field] = rule;
      else delete fields[field];
      return { ...m, version: 2, fields };
    });
    setDirty(true);
    setMessage(null);
  };
  const setMoney = (money: SmartMapping["money"]) => {
    setMapping((m) => {
      const next: SmartMapping = { ...m };
      if (money) next.money = money;
      else delete next.money;
      return next;
    });
    setDirty(true);
    setMessage(null);
  };
  const setKeep = (columns: string[]) => {
    setMapping((m) => {
      const next: SmartMapping = { ...m };
      if (columns.length) next.keepColumns = columns;
      else delete next.keepColumns;
      return next;
    });
    setDirty(true);
    setMessage(null);
  };
  const setOptions = (options: SmartExpiryOptions) => {
    setMapping((m) => ({ ...m, options }));
    setDirty(true);
    setMessage(null);
  };

  const setMode = (field: ClientImportFieldKey, mode: Mode) => {
    const current = mapping.fields[field];
    if (mode === "empty") return setRule(field, undefined);
    if (mode === "sample") return setRule(field, { mode: "sample" });
    if (mode === "constant") return setRule(field, { mode: "constant", value: current?.mode === "constant" ? current.value : (CHOICES[field]?.[0]?.value ?? "") });
    return setRule(field, { mode: "source", column: current?.mode === "source" ? current.column : "" });
  };

  async function save(): Promise<boolean> {
    if (!ctx) return false;
    const next = mappingToSave(mapping);
    setSaving(true);
    const r = await saveSmartMapping(jobId, ctx.revision, next);
    setSaving(false);
    if (!r.ok) {
      setMessage({ tone: "danger", text: r.message });
      return false;
    }
    setCtx({ ...ctx, revision: r.revision ?? ctx.revision + 1, mapping: next });
    setMapping(next);
    setDirty(false);
    return true;
  }

  const filledHint = (column: string) => `${(ctx.columnFilled[column] ?? 0).toLocaleString()} filled`;
  const preview = (field: ClientImportFieldKey): string[] => {
    const rule = mapping.fields[field];
    if (!rule) return [];
    if (rule.mode === "sample") return [ctx.samples[field] || "—"];
    if (rule.mode === "constant") return [rule.value || "—"];
    if (rule.mode !== "source") return [];
    const first = ctx.columnPreview[rule.column] ?? [];
    return first.length ? first.slice(0, 3) : rule.fallback ? (ctx.columnPreview[rule.fallback] ?? []).slice(0, 3) : [];
  };
  const moneyColumns = new Set(mapping.money?.mode === "MULTI" ? mapping.money.columns.map((c) => c.column) : mapping.money ? [mapping.money.amountColumn, mapping.money.currencyColumn ?? ""] : []);
  const unused = ctx.headers.filter((h) => !usage.has(h) && !moneyColumns.has(h));
  const moneyPanel = (
    <MoneyPanel
      headers={ctx.headers}
      unused={unused}
      previewRows={ctx.previewRows}
      money={mapping.money}
      keepColumns={mapping.keepColumns ?? []}
      onMoney={setMoney}
      onKeep={setKeep}
    />
  );
  const visibleSuggestions = ctx.suggestions.filter((s) => !mapping.fields[s.field]);

  const toggle = (
    <div role="radiogroup" aria-label="Mapping view" className="inline-flex gap-1 rounded-[var(--radius-md)] bg-[var(--color-neutral-bg)] p-1">
      {(
        [
          ["grid", "Spreadsheet view", Table2],
          ["detailed", "Detailed view", LayoutList],
        ] as const
      ).map(([key, label, Icon]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={view === key}
          onClick={() => writeMappingView(key)}
          className={`inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-1.5 text-[12.5px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] ${view === key ? "bg-[var(--color-surface)] text-[color:var(--color-foreground)] shadow-[var(--shadow-xs)]" : "text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"}`}
        >
          <Icon className="size-3.5" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );

  const presetBar = (
    <PresetBar
      jobId={jobId}
      presets={presets}
      dirty={dirty}
      onSaveFirst={save}
      onApplied={async (msg) => {
        await load();
        setMessage({ tone: "info", text: msg });
      }}
      onChanged={async () => setPresets(await listSmartPresets())}
    />
  );

  const saveBar = (
    <div className="sticky bottom-0 z-30 -mx-1 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]/95 p-3 shadow-[var(--shadow-lg)] backdrop-blur">
      <div className="min-w-0 text-[12.5px]" aria-live="polite">
        {message ? (
          <span className={message.tone === "danger" ? "text-[color:var(--color-danger-fg)]" : "text-[color:var(--color-muted-foreground)]"}>{message.text}</span>
        ) : dirty ? (
          <span className="text-[color:var(--color-muted-foreground)]">Unsaved changes</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[color:var(--color-success-fg)]">
            <Check className="size-3.5" aria-hidden />
            Saved
          </span>
        )}
      </div>
      <Button
        loading={saving}
        onClick={async () => {
          if (!dirty || (await save())) onSaved(ctx.revision);
        }}
      >
        Save mapping and review rows
        <ArrowRight className="size-4" aria-hidden />
      </Button>
    </div>
  );

  if (view === "grid") {
    return (
      <div className="min-w-0 space-y-4" data-mapping-editor>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {toggle}
          <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
            Your fields across the top · the Excel column for each below it · {ctx.previewRows.length} of your rows below that
          </p>
        </div>
        {presetBar}
        <label className="flex items-start gap-2 text-[12.5px]">
          <Checkbox
            checked={mapping.fillLocale !== false}
            onChange={(e) => {
              setMapping((m) => {
                const next: SmartMapping = { ...m };
                if (e.target.checked) delete next.fillLocale;
                else next.fillLocale = false;
                return next;
              });
              setDirty(true);
              setMessage(null);
            }}
          />
          <span>
            Fill an empty country, preferred currency and language from each client&apos;s valid phone number
            <span className="block text-[11.5px] text-[color:var(--color-muted-foreground)]">
              Shown as <span className="text-[color:var(--color-info-fg)]">Auto selected</span> below and in the review. A value your file gives is always kept; an existing client&apos;s value is never replaced by a suggestion.
            </span>
          </span>
        </label>
        <MappingGrid
          groups={SMART_FIELD_GROUPS}
          headers={ctx.headers}
          columnFilled={ctx.columnFilled}
          mapping={mapping}
          samples={ctx.samples}
          previewRows={ctx.previewRows}
          defaultCountry={ctx.defaultCountry}
          suggestions={visibleSuggestions}
          choices={CHOICES}
          onRule={setRule}
        />
        {moneyPanel}
        <ExpiryPanel mapping={mapping} headers={ctx.headers} preview={ctx.columnPreview} setRule={setRule} setOptions={setOptions} />
        {saveBar}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_300px]" data-mapping-editor>
      <div className="min-w-0 space-y-4">
        {toggle}
        {visibleSuggestions.length ? (
          <Card className="border-[var(--color-info-border)] bg-[var(--color-info-bg)] p-4!">
            <p className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-[color:var(--color-info-fg)]">
              <Lightbulb className="size-4" aria-hidden />
              Possible matches — check before using
            </p>
            <ul className="flex flex-wrap gap-2">
              {visibleSuggestions.map((s) => (
                <li key={`${s.field}:${s.column}`}>
                  <button
                    type="button"
                    onClick={() => setRule(s.field, { mode: "source", column: s.column })}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-info-border)] bg-[var(--color-surface)] px-3 py-1 text-[12.5px] hover:border-[var(--color-accent)]"
                  >
                    <Wand2 className="size-3.5" aria-hidden />
                    <span className="font-medium">{s.column}</span>
                    <ArrowRight className="size-3" aria-hidden />
                    {labelOf(s.field)}
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {presetBar}

        {SMART_FIELD_GROUPS.map((group) => (
          <Card key={group.title} className="overflow-hidden p-0!">
            <h3 className="border-b border-[var(--color-border)] bg-[var(--color-neutral-bg)]/60 px-4 py-2.5 text-[12px] font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">{group.title}</h3>
            <ul className="divide-y divide-[var(--color-border)]">
              {group.fields.map((field) => {
                const rule = mapping.fields[field];
                const mode = modeOf(rule);
                const required = CLIENT_IMPORT_FIELDS.find((f) => f.key === field)?.required;
                const identity = (SMART_IDENTITY_FIELDS as readonly string[]).includes(field);
                const samples = ctx.samples[field];
                const shown = preview(field);
                return (
                  <li key={field} data-field={field} className="grid gap-3 px-4 py-3.5 md:grid-cols-[180px_minmax(0,1fr)]">
                    <div>
                      <p className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-medium">
                        {labelOf(field)}
                        {required ? <Badge color="blue">required</Badge> : null}
                        {identity ? (
                          <span title="Clients are recognised by this field" className="inline-flex text-[color:var(--color-muted-foreground)]">
                            <KeyRound className="size-3.5" aria-label="identifies a client" />
                          </span>
                        ) : null}
                      </p>
                      {FIELD_HINTS[field] ? <p className="mt-0.5 text-[11.5px] leading-snug text-[color:var(--color-muted-foreground)]">{FIELD_HINTS[field]}</p> : null}
                    </div>
                    <div className="min-w-0 space-y-2">
                      <div role="radiogroup" aria-label={`Where ${labelOf(field)} comes from`} className="inline-flex flex-wrap gap-1 rounded-[var(--radius-md)] bg-[var(--color-neutral-bg)] p-1">
                        {(Object.keys(MODE_LABELS) as Mode[]).map((m) => {
                          const disabled = m === "sample" && !samples;
                          return (
                            <button
                              key={m}
                              type="button"
                              role="radio"
                              aria-checked={mode === m}
                              disabled={disabled}
                              title={disabled ? "No sample is available for this field in this project" : undefined}
                              onClick={() => setMode(field, m)}
                              className={`rounded-[var(--radius-sm)] px-2.5 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] disabled:cursor-not-allowed disabled:opacity-40 ${
                                mode === m ? "bg-[var(--color-surface)] text-[color:var(--color-foreground)] shadow-[var(--shadow-xs)]" : "text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
                              }`}
                            >
                              {MODE_LABELS[m]}
                            </button>
                          );
                        })}
                      </div>

                      {rule?.mode === "source" ? (
                        <div className="grid gap-2 sm:grid-cols-2">
                          <label className="block">
                            <span className="sr-only">Column for {labelOf(field)}</span>
                            <Select value={rule.column} onChange={(e) => setRule(field, { mode: "source", column: e.target.value, fallback: rule.fallback })} className="w-full">
                              <option value="">Choose a column…</option>
                              {ctx.headers.map((h) => (
                                <option key={h} value={h}>
                                  {h} — {filledHint(h)}
                                </option>
                              ))}
                            </Select>
                          </label>
                          <label className="block">
                            <span className="sr-only">If empty, use</span>
                            <Select
                              value={rule.fallback ?? ""}
                              onChange={(e) => setRule(field, { mode: "source", column: rule.column, ...(e.target.value ? { fallback: e.target.value } : {}) })}
                              className="w-full"
                              disabled={!rule.column}
                            >
                              <option value="">If empty: leave empty</option>
                              {ctx.headers
                                .filter((h) => h !== rule.column)
                                .map((h) => (
                                  <option key={h} value={h}>
                                    If empty: use {h}
                                  </option>
                                ))}
                            </Select>
                          </label>
                        </div>
                      ) : null}
                      {rule?.mode === "constant" && !rule.sample ? (
                        CHOICES[field] ? (
                          <Select value={rule.value} onChange={(e) => setRule(field, { mode: "constant", value: e.target.value })} className="w-full sm:w-64" aria-label={`Value for ${labelOf(field)}`}>
                            {CHOICES[field]!.map((c) => (
                              <option key={c.value} value={c.value}>
                                {c.label}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <Input
                            value={rule.value}
                            maxLength={2000}
                            onChange={(e) => setRule(field, { mode: "constant", value: e.target.value })}
                            placeholder={`The ${labelOf(field).toLowerCase()} for every row`}
                            aria-label={`Value for ${labelOf(field)}`}
                            className="w-full sm:max-w-md"
                            dir="auto"
                          />
                        )
                      ) : null}
                      {mode === "sample" ? (
                        <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">
                          Every row gets the sample value <span className="rounded bg-[var(--color-warning-bg)] px-1.5 py-0.5 font-medium text-[color:var(--color-warning-fg)]">{samples || "—"}</span> — a placeholder, not real data. Change it on the review screen later if you need to.
                        </p>
                      ) : null}
                      {identity && (mode === "constant" || mode === "sample") ? (
                        <p className="text-[12px] text-[color:var(--color-warning-fg)]">
                          The same {labelOf(field).toLowerCase()} on every row makes every row the same client: only the first will be imported, the rest show as repeats.
                        </p>
                      ) : null}
                      {(SMART_ROSTER_FIELDS as readonly string[]).includes(field) && mode === "constant" ? (
                        <p className="text-[12px] text-[color:var(--color-muted-foreground)]">Checked against this project&apos;s teams and people when you save.</p>
                      ) : null}
                      {shown.length ? (
                        <p className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-[color:var(--color-muted-foreground)]">
                          <span>Preview:</span>
                          {shown.map((v, i) => (
                            <span key={i} className="max-w-48 truncate rounded bg-[var(--color-neutral-bg)] px-1.5 py-0.5 text-[color:var(--color-foreground)]" dir="auto">
                              {v}
                            </span>
                          ))}
                        </p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        ))}

        <ExpiryPanel mapping={mapping} headers={ctx.headers} preview={ctx.columnPreview} setRule={setRule} setOptions={setOptions} />
        {moneyPanel}

        {saveBar}
      </div>

      <aside className="space-y-3 xl:sticky xl:top-4 xl:self-start">
        <Card className="p-4!">
          <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
            <Columns3 className="size-4 text-[color:var(--color-muted-foreground)]" aria-hidden />
            Your file&apos;s columns
          </h3>
          <ul className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
            {ctx.headers.map((h) => {
              const fields = usage.get(h) ?? [];
              return (
                <li key={h} className={`rounded-[var(--radius-md)] border p-2.5 ${fields.length ? "border-[var(--color-border)]" : "border-dashed border-[var(--color-border)] opacity-70"}`}>
                  <p className="truncate text-[12.5px] font-medium" title={h}>
                    {h}
                  </p>
                  <p className="truncate text-[11px] text-[color:var(--color-muted-foreground)]" dir="auto">
                    {(ctx.columnPreview[h] ?? []).join(" · ") || "empty"}
                  </p>
                  <p className="mt-1 flex flex-wrap gap-1">
                    {fields.length ? fields.map((f) => <Badge key={f} color="blue">{labelOf(f)}</Badge>) : <span className="text-[11px] text-[color:var(--color-muted-foreground)]">Not imported</span>}
                  </p>
                </li>
              );
            })}
          </ul>
          {unused.length ? <p className="mt-3 text-[11.5px] text-[color:var(--color-muted-foreground)]">{unused.length} column(s) are not imported. That is fine — only mapped fields are read.</p> : null}
        </Card>
      </aside>
    </div>
  );
}

function PresetBar({
  jobId,
  presets,
  dirty,
  onSaveFirst,
  onApplied,
  onChanged,
}: {
  jobId: string;
  presets: SmartPreset[];
  dirty: boolean;
  onSaveFirst: () => Promise<boolean>;
  onApplied: (message: string) => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const [choice, setChoice] = useState("");
  const [name, setName] = useState("");
  const [shared, setShared] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const chosen = presets.find((p) => p.id === choice);

  return (
    <Card className="flex flex-col gap-3 p-4! lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
          <Bookmark className="size-3.5" aria-hidden />
          Saved mappings
        </span>
        <div className="flex gap-2">
          <Select value={choice} onChange={(e) => setChoice(e.target.value)} className="min-w-0 flex-1" aria-label="Saved mapping">
            <option value="">{presets.length ? "Choose a saved mapping…" : "None saved yet"}</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} {p.shared ? "· shared" : "· only me"} ({p.fields} fields)
              </option>
            ))}
          </Select>
          <Button
            variant="secondary"
            disabled={!choice || busy}
            onClick={async () => {
              setBusy(true);
              const ctx = await loadSmartMappingContext(jobId);
              const r = "error" in ctx ? { ok: false, message: ctx.error } : await applySmartPreset(jobId, ctx.revision, choice);
              setBusy(false);
              await onApplied(r.message);
            }}
          >
            Apply
          </Button>
          {chosen?.mine ? (
            <Button
              variant="ghost"
              aria-label={`Delete ${chosen.name}`}
              disabled={busy}
              onClick={async () => {
                if (!window.confirm(`Delete the saved mapping "${chosen.name}"? Imports already made are not affected.`)) return;
                const r = await deleteSmartPreset(chosen.id);
                setNote(r.message);
                setChoice("");
                await onChanged();
              }}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          ) : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-[12.5px] font-medium">Save this mapping for next time</span>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Billing software export" className="min-w-40 flex-1" aria-label="Mapping name" />
          <label className="flex items-center gap-1.5 text-[12px]">
            <Checkbox checked={shared} onChange={(e) => setShared(e.target.checked)} />
            Share with the team
          </label>
          <Button
            variant="secondary"
            disabled={!name.trim() || busy}
            onClick={async () => {
              setBusy(true);
              if (dirty && !(await onSaveFirst())) {
                setBusy(false);
                return;
              }
              const r = await saveSmartPreset(jobId, name, shared);
              setBusy(false);
              setNote(r.message);
              if (r.ok) {
                setName("");
                await onChanged();
              }
            }}
          >
            Save
          </Button>
        </div>
      </div>
      {note ? (
        <p className="text-[12px] text-[color:var(--color-muted-foreground)] lg:basis-full" aria-live="polite">
          {note}
        </p>
      ) : null}
    </Card>
  );
}
