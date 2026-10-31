"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, Check, GitMerge, Pencil, Plus, RotateCcw, Search, Star, Trash2 } from "lucide-react";
import { CLIENT_CATALOG_KIND_LABELS, type ClientCatalogKindValue } from "@support-automation/shared";
import { Alert, Badge, Button, Card, Input, Select } from "@/components/ui";
import type { CatalogEntryView, ClientConfiguration, ServicePlanView } from "@/server/clientConfiguration";
import {
  addUsedValuesToCatalog,
  mergeCatalogEntries,
  saveCatalogEntry,
  saveCountrySetting,
  saveServicePlan,
  setCatalogEntryArchived,
  setCurrencyFavorite,
  setProjectCurrency,
  setServicePlanArchived,
  type ConfigResult,
} from "@/server/actions/clientConfiguration";

/**
 * The Client Configuration Center (CLIENT_CONFIGURATION.md). Each tab edits one of the project's lists through
 * its own server action (which checks the permission and writes the System Log); the page re-reads after each.
 */

type Tab = ClientCatalogKindValue | "PLANS" | "CURRENCIES" | "COUNTRIES" | "LANGUAGES";
const TABS: Array<[Tab, string]> = [
  ["TAG", "Tags"],
  ["CATEGORY", "Categories"],
  ["BUSINESS_TYPE", "Business types"],
  ["PLANS", "Services & plans"],
  ["CURRENCIES", "Currencies"],
  ["COUNTRIES", "Countries"],
  ["LANGUAGES", "Languages"],
];

interface Props {
  canEdit: boolean;
  config: ClientConfiguration;
  currencies: Array<{ code: string; name: string; decimals: number }>;
  countries: Array<{ code: string; name: string; callingCode: string; currency: string | null; language: string | null }>;
  languages: string[];
}

export function ConfigurationCenter(props: Props) {
  const [tab, setTab] = useState<Tab>("TAG");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const run = (fn: () => Promise<ConfigResult>) =>
    start(async () => {
      const r = await fn();
      setMessage({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });

  return (
    <div className="space-y-4">
      <nav aria-label="Client lists" className="-mx-1 flex gap-1 overflow-x-auto pb-1">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setTab(key);
              setMessage(null);
            }}
            aria-current={tab === key ? "page" : undefined}
            className={`shrink-0 rounded-[var(--radius-md)] px-3 py-1.5 text-[13px] font-medium ${tab === key ? "bg-[var(--color-primary)] text-[color:var(--color-on-primary)]" : "text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)]"}`}
          >
            {label}
          </button>
        ))}
      </nav>
      {message ? (
        <Alert tone={message.ok ? "success" : "danger"} aria-live="polite">
          {message.text}
        </Alert>
      ) : null}
      {tab === "TAG" || tab === "CATEGORY" || tab === "BUSINESS_TYPE" ? (
        <CatalogTab key={tab} kind={tab} entries={props.config.entries[tab]} unlisted={props.config.unlisted[tab]} canEdit={props.canEdit} pending={pending} run={run} />
      ) : null}
      {tab === "PLANS" ? <PlansTab plans={props.config.plans} unlisted={props.config.unlistedServices} currencies={props.currencies} canEdit={props.canEdit} pending={pending} run={run} /> : null}
      {tab === "CURRENCIES" ? <CurrenciesTab all={props.currencies} project={props.config.currencies} canEdit={props.canEdit} pending={pending} run={run} /> : null}
      {tab === "COUNTRIES" ? <CountriesTab all={props.countries} saved={props.config.countries} currencies={props.currencies} languages={props.languages} canEdit={props.canEdit} pending={pending} run={run} /> : null}
      {tab === "LANGUAGES" ? <LanguagesTab languages={props.languages} countries={props.countries} /> : null}
    </div>
  );
}

type Run = (fn: () => Promise<ConfigResult>) => void;

function SearchBox({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="flex max-w-sm items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5">
      <Search className="size-4 text-[color:var(--color-muted-foreground)]" aria-hidden />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={label} aria-label={label} className="h-9 w-full bg-transparent text-[13px] outline-none" />
    </label>
  );
}

// ── Tags, categories, business types ────────────────────────────────────────────────────────────

function CatalogTab({ kind, entries, unlisted, canEdit, pending, run }: { kind: ClientCatalogKindValue; entries: CatalogEntryView[]; unlisted: Array<{ name: string; clients: number }>; canEdit: boolean; pending: boolean; run: Run }) {
  const labels = CLIENT_CATALOG_KIND_LABELS[kind];
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", aliases: "" });
  const [merging, setMerging] = useState<{ from: string; into: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const shown = entries.filter((e) => (showArchived || !e.archived) && (!query || `${e.name} ${e.aliases.join(" ")}`.toLowerCase().includes(query.toLowerCase())));

  return (
    <Card className="space-y-4 p-4!">
      {canEdit ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await saveCatalogEntry({ kind, name, aliases });
              if (r.ok) {
                setName("");
                setAliases("");
              }
              return r;
            });
          }}
        >
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-[12.5px] font-medium">
            New {labels.one.toLowerCase()}
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={kind === "TAG" ? "e.g. vip" : kind === "CATEGORY" ? "e.g. Corporate" : "e.g. Retail"} />
          </label>
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-[12.5px] font-medium">
            Other spellings (import matches these)
            <Input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="e.g. Corp, Company" />
          </label>
          <Button type="submit" disabled={!name.trim() || pending}>
            <Plus className="size-4" aria-hidden /> Add
          </Button>
        </form>
      ) : null}

      {unlisted.length ? (
        <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] p-3 text-[12.5px]">
          <p className="mb-2 text-[color:var(--color-muted-foreground)]">
            Already on clients but not on this list ({unlisted.length}): {unlisted.slice(0, 12).map((u) => `${u.name} (${u.clients})`).join(", ")}
            {unlisted.length > 12 ? "…" : ""}
          </p>
          {canEdit ? (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => addUsedValuesToCatalog(kind, unlisted.map((u) => u.name)))}>
              Add all {unlisted.length} to the list
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <SearchBox value={query} onChange={setQuery} label={`Search ${labels.many.toLowerCase()}`} />
        <label className="flex items-center gap-1.5 text-[12.5px]">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
        </label>
      </div>

      <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
        {shown.length === 0 ? <li className="px-3 py-6 text-center text-[13px] text-[color:var(--color-muted-foreground)]">No {labels.many.toLowerCase()} yet.</li> : null}
        {shown.map((e) => (
          <li key={e.id} data-entry={e.name} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
            {editing === e.id ? (
              <form
                className="flex flex-1 flex-wrap items-center gap-2"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  run(async () => {
                    const r = await saveCatalogEntry({ kind, id: e.id, name: draft.name, aliases: draft.aliases });
                    if (r.ok) setEditing(null);
                    return r;
                  });
                }}
              >
                <Input aria-label="Name" value={draft.name} onChange={(ev) => setDraft({ ...draft, name: ev.target.value })} className="min-w-40 flex-1" />
                <Input aria-label="Other spellings" value={draft.aliases} onChange={(ev) => setDraft({ ...draft, aliases: ev.target.value })} className="min-w-40 flex-1" />
                <Button size="sm" type="submit" disabled={pending}>
                  <Check className="size-3.5" aria-hidden /> Save
                </Button>
                <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <>
                <span className="min-w-0 flex-1">
                  <span className={`text-[13.5px] font-medium ${e.archived ? "text-[color:var(--color-muted-foreground)] line-through" : ""}`}>{e.name}</span>
                  {e.aliases.length ? <span className="ml-2 text-[12px] text-[color:var(--color-muted-foreground)]">also {e.aliases.join(", ")}</span> : null}
                </span>
                <Badge color="gray">{e.clients.toLocaleString()} client{e.clients === 1 ? "" : "s"}</Badge>
                {canEdit ? (
                  <span className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" aria-label={`Edit ${e.name}`} onClick={() => (setEditing(e.id), setDraft({ name: e.name, aliases: e.aliases.join(", ") }))}>
                      <Pencil className="size-3.5" aria-hidden />
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={`Merge ${e.name} into another`} onClick={() => setMerging({ from: e.id, into: "" })}>
                      <GitMerge className="size-3.5" aria-hidden />
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={e.archived ? `Restore ${e.name}` : `Archive ${e.name}`} disabled={pending} onClick={() => run(() => setCatalogEntryArchived(e.id, !e.archived))}>
                      {e.archived ? <RotateCcw className="size-3.5" aria-hidden /> : <Archive className="size-3.5" aria-hidden />}
                    </Button>
                  </span>
                ) : null}
              </>
            )}
            {merging?.from === e.id ? (
              <div className="flex w-full flex-wrap items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-neutral-bg)] p-2 text-[12.5px]">
                Merge &ldquo;{e.name}&rdquo; into
                <Select aria-label="Merge into" value={merging.into} onChange={(ev) => setMerging({ ...merging, into: ev.target.value })} className="min-w-40">
                  <option value="">Choose…</option>
                  {entries
                    .filter((x) => x.id !== e.id)
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                </Select>
                <Button size="sm" disabled={!merging.into || pending} onClick={() => run(async () => (setMerging(null), mergeCatalogEntries(e.id, merging.into)))}>
                  Merge
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMerging(null)}>
                  Cancel
                </Button>
                <span className="basis-full text-[color:var(--color-muted-foreground)]">Its {e.clients.toLocaleString()} client(s) get the other name; &ldquo;{e.name}&rdquo; becomes one of its spellings on import.</span>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── Plans ───────────────────────────────────────────────────────────────────────────────────────

const KIND_LABELS: Record<string, string> = { PAID: "Paid", TRIAL: "Trial", DEMO: "Demo", COMPLIMENTARY: "Complimentary" };
const UNIT_LABELS: Record<string, string> = { DAY: "days", WEEK: "weeks", MONTH: "months", YEAR: "years" };
type PlanDraft = { id?: string; name: string; service: string; defaultKind: string; defaultDuration: string; defaultUnit: string; prices: Array<{ currency: string; amount: string }>; aliases: string };
const emptyPlan: PlanDraft = { name: "", service: "", defaultKind: "PAID", defaultDuration: "", defaultUnit: "", prices: [], aliases: "" };

function PlansTab({ plans, unlisted, currencies, canEdit, pending, run }: { plans: ServicePlanView[]; unlisted: Array<{ name: string; subscriptions: number }>; currencies: Props["currencies"]; canEdit: boolean; pending: boolean; run: Run }) {
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [query, setQuery] = useState("");
  const shown = plans.filter((p) => !query || `${p.name} ${p.service ?? ""} ${p.aliases.join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <Card className="space-y-4 p-4!">
      <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">
        A plan&apos;s kind, duration and price are offered when someone picks it on Add / Edit Client — they can change any of it. Choosing a paid plan never creates an invoice.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SearchBox value={query} onChange={setQuery} label="Search plans" />
        {canEdit && !draft ? (
          <Button onClick={() => setDraft({ ...emptyPlan })}>
            <Plus className="size-4" aria-hidden /> New plan
          </Button>
        ) : null}
      </div>
      {draft ? <PlanForm draft={draft} setDraft={setDraft} currencies={currencies} pending={pending} run={run} /> : null}
      {unlisted.length && canEdit ? (
        <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] p-3 text-[12.5px]">
          <p className="mb-2 text-[color:var(--color-muted-foreground)]">Services already sold that no plan names:</p>
          <div className="flex flex-wrap gap-1.5">
            {unlisted.slice(0, 30).map((u) => (
              <button key={u.name} type="button" onClick={() => setDraft({ ...emptyPlan, name: u.name })} className="rounded-full border border-[var(--color-border)] px-2.5 py-1 hover:border-[var(--color-accent)]">
                + {u.name} <span className="text-[color:var(--color-muted-foreground)]">({u.subscriptions})</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
        {shown.length === 0 ? <li className="px-3 py-6 text-center text-[13px] text-[color:var(--color-muted-foreground)]">No plans yet.</li> : null}
        {shown.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className={`text-[13.5px] font-medium ${p.archived ? "line-through text-[color:var(--color-muted-foreground)]" : ""}`}>{p.name}</span>
              {p.service ? <span className="ml-2 text-[12px] text-[color:var(--color-muted-foreground)]">{p.service}</span> : null}
              <span className="block text-[12px] text-[color:var(--color-muted-foreground)]">
                {KIND_LABELS[p.defaultKind] ?? p.defaultKind}
                {p.defaultDuration && p.defaultUnit ? ` · ${p.defaultDuration} ${UNIT_LABELS[p.defaultUnit]}` : " · custom dates"}
                {p.prices.length ? ` · ${p.prices.map((x) => `${x.currency} ${x.amount}`).join(", ")}` : ""}
                {p.aliases.length ? ` · also ${p.aliases.join(", ")}` : ""}
              </span>
            </span>
            {canEdit ? (
              <span className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Edit ${p.name}`}
                  onClick={() => setDraft({ id: p.id, name: p.name, service: p.service ?? "", defaultKind: p.defaultKind, defaultDuration: p.defaultDuration ? String(p.defaultDuration) : "", defaultUnit: p.defaultUnit ?? "", prices: p.prices, aliases: p.aliases.join(", ") })}
                >
                  <Pencil className="size-3.5" aria-hidden />
                </Button>
                <Button size="sm" variant="ghost" aria-label={p.archived ? `Restore ${p.name}` : `Archive ${p.name}`} disabled={pending} onClick={() => run(() => setServicePlanArchived(p.id, !p.archived))}>
                  {p.archived ? <RotateCcw className="size-3.5" aria-hidden /> : <Archive className="size-3.5" aria-hidden />}
                </Button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PlanForm({ draft, setDraft, currencies, pending, run }: { draft: PlanDraft; setDraft: (d: PlanDraft | null) => void; currencies: Props["currencies"]; pending: boolean; run: Run }) {
  const set = (patch: Partial<PlanDraft>) => setDraft({ ...draft, ...patch });
  return (
    <form
      className="grid gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-neutral-bg)]/50 p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const r = await saveServicePlan(draft);
          if (r.ok) setDraft(null);
          return r;
        });
      }}
    >
      <label className="flex flex-col gap-1 text-[12.5px] font-medium">
        Plan name
        <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} required />
      </label>
      <label className="flex flex-col gap-1 text-[12.5px] font-medium">
        Service (optional)
        <Input value={draft.service} onChange={(e) => set({ service: e.target.value })} maxLength={120} placeholder="e.g. Internet" />
      </label>
      <label className="flex flex-col gap-1 text-[12.5px] font-medium">
        Usually sold as
        <Select value={draft.defaultKind} onChange={(e) => set({ defaultKind: e.target.value })}>
          {Object.entries(KIND_LABELS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </Select>
      </label>
      <div className="flex flex-col gap-1 text-[12.5px] font-medium">
        Default duration
        <div className="flex gap-2">
          <Input aria-label="Duration" inputMode="numeric" value={draft.defaultDuration} onChange={(e) => set({ defaultDuration: e.target.value.replace(/\D/g, "") })} placeholder="e.g. 1" className="w-24" />
          <Select aria-label="Unit" value={draft.defaultUnit} onChange={(e) => set({ defaultUnit: e.target.value })} className="flex-1">
            <option value="">Custom dates</option>
            {Object.entries(UNIT_LABELS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="flex flex-col gap-1 text-[12.5px] font-medium sm:col-span-2">
        Price suggestions (optional — one per currency, in that currency&apos;s own decimals)
        {draft.prices.map((p, i) => (
          <div key={i} className="flex gap-2">
            <Select aria-label="Currency" value={p.currency} onChange={(e) => set({ prices: draft.prices.map((x, j) => (j === i ? { ...x, currency: e.target.value } : x)) })} className="w-56">
              <option value="">Currency…</option>
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </Select>
            <Input aria-label="Amount" inputMode="decimal" value={p.amount} onChange={(e) => set({ prices: draft.prices.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)) })} placeholder={currencies.find((c) => c.code === p.currency)?.decimals === 3 ? "e.g. 8.000" : "e.g. 30.00"} className="w-36" />
            <Button size="sm" variant="ghost" type="button" aria-label="Remove price" onClick={() => set({ prices: draft.prices.filter((_, j) => j !== i) })}>
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          </div>
        ))}
        <Button size="sm" variant="secondary" type="button" className="w-fit" onClick={() => set({ prices: [...draft.prices, { currency: "", amount: "" }] })}>
          <Plus className="size-3.5" aria-hidden /> Add a price
        </Button>
      </div>
      <label className="flex flex-col gap-1 text-[12.5px] font-medium sm:col-span-2">
        Other names in spreadsheets (import matches these)
        <Input value={draft.aliases} onChange={(e) => set({ aliases: e.target.value })} placeholder="e.g. 20M, Home20" />
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={pending || !draft.name.trim()}>
          {draft.id ? "Save plan" : "Add plan"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ── Currencies ──────────────────────────────────────────────────────────────────────────────────

function CurrenciesTab({ all, project, canEdit, pending, run }: { all: Props["currencies"]; project: ClientConfiguration["currencies"]; canEdit: boolean; pending: boolean; run: Run }) {
  const [query, setQuery] = useState("");
  const state = useMemo(() => new Map(project.map((c) => [c.code, c])), [project]);
  // Codes older records use that are not current ISO currencies stay visible, never removed.
  const rows = [...all, ...project.filter((p) => !all.some((a) => a.code === p.code)).map((p) => ({ code: p.code, name: "(no longer an ISO currency)", decimals: 2 }))];
  const q = query.trim().toLowerCase();
  const shown = rows
    .filter((c) => !q || c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
    .sort((a, b) => Number(state.get(b.code)?.favorite ?? false) - Number(state.get(a.code)?.favorite ?? false) || Number(state.get(b.code)?.enabled ?? false) - Number(state.get(a.code)?.enabled ?? false) || a.code.localeCompare(b.code));
  return (
    <Card className="space-y-3 p-4!">
      <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">
        Every ISO currency ({all.length}) can be offered — there is no limit. Offering a currency only lets people pick it; nothing is ever converted between currencies or added across them. Favourites are shown first everywhere.
      </p>
      <SearchBox value={query} onChange={setQuery} label="Search by code or name (e.g. SAR, rial)" />
      <div className="max-h-[60vh] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
        <table className="w-full text-[13px]">
          <thead className="sticky top-0 bg-[var(--color-neutral-bg)] text-left text-[11.5px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            <tr>
              <th className="px-3 py-2">Currency</th>
              <th className="px-3 py-2">Decimals</th>
              <th className="px-3 py-2">Offered</th>
              <th className="px-3 py-2">Favourite</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {shown.map((c) => {
              const s = state.get(c.code);
              return (
                <tr key={c.code} data-currency={c.code}>
                  <td className="px-3 py-1.5">
                    <span className="font-semibold">{c.code}</span> <span className="text-[color:var(--color-muted-foreground)]">{c.name}</span>
                  </td>
                  <td className="px-3 py-1.5 tabular-nums">{c.decimals}</td>
                  <td className="px-3 py-1.5">
                    <input type="checkbox" aria-label={`Offer ${c.code}`} disabled={!canEdit || pending} checked={Boolean(s?.enabled)} onChange={(e) => run(() => setProjectCurrency(c.code, e.target.checked))} />
                  </td>
                  <td className="px-3 py-1.5">
                    <button type="button" aria-label={s?.favorite ? `Unmark ${c.code}` : `Mark ${c.code} favourite`} aria-pressed={Boolean(s?.favorite)} disabled={!canEdit || pending} onClick={() => run(() => setCurrencyFavorite(c.code, !s?.favorite))}>
                      <Star className={`size-4 ${s?.favorite ? "fill-[var(--color-warning)] text-[color:var(--color-warning)]" : "text-[color:var(--color-subtle-foreground)]"}`} aria-hidden />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Countries ───────────────────────────────────────────────────────────────────────────────────

function CountriesTab({ all, saved, currencies, languages, canEdit, pending, run }: { all: Props["countries"]; saved: ClientConfiguration["countries"]; currencies: Props["currencies"]; languages: string[]; canEdit: boolean; pending: boolean; run: Run }) {
  const [query, setQuery] = useState("");
  const byCode = useMemo(() => new Map(saved.map((s) => [s.country, s])), [saved]);
  const q = query.trim().toLowerCase().replace(/^\+/, "");
  const shown = all
    .filter((c) => (q ? c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q || c.callingCode === q : byCode.has(c.code)))
    .slice(0, 60);
  return (
    <Card className="space-y-3 p-4!">
      <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">
        When a client&apos;s country is known (from the file, a person, or a valid phone number), its usual currency and language are suggested. Override them here for this project; favourites are listed first in country pickers.
      </p>
      <SearchBox value={query} onChange={setQuery} label="Search a country, code or calling code (e.g. Saudi, SA, 966)" />
      {!q && !saved.length ? <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">No country has project settings yet. Search to change one.</p> : null}
      <datalist id="config-languages">
        {languages.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
      <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
        {shown.map((c) => (
          <CountryRow key={c.code} country={c} saved={byCode.get(c.code)} currencies={currencies} canEdit={canEdit} pending={pending} run={run} />
        ))}
      </ul>
    </Card>
  );
}

function CountryRow({ country, saved, currencies, canEdit, pending, run }: { country: Props["countries"][number]; saved?: ClientConfiguration["countries"][number]; currencies: Props["currencies"]; canEdit: boolean; pending: boolean; run: Run }) {
  const [currency, setCurrency] = useState(saved?.currency ?? "");
  const [language, setLanguage] = useState(saved?.language ?? "");
  const favorite = Boolean(saved?.favorite);
  return (
    <li data-country={country.code} className="flex flex-wrap items-center gap-2 px-3 py-2">
      <button type="button" aria-label={favorite ? `Unmark ${country.name}` : `Mark ${country.name} favourite`} aria-pressed={favorite} disabled={!canEdit || pending} onClick={() => run(() => saveCountrySetting({ country: country.code, favorite: !favorite, currency: saved?.currency ?? null, language: saved?.language ?? null }))}>
        <Star className={`size-4 ${favorite ? "fill-[var(--color-warning)] text-[color:var(--color-warning)]" : "text-[color:var(--color-subtle-foreground)]"}`} aria-hidden />
      </button>
      <span className="min-w-40 flex-1 text-[13px]">
        <span className="font-medium">{country.name}</span> <span className="text-[color:var(--color-muted-foreground)]">{country.code} · +{country.callingCode}</span>
      </span>
      <Select aria-label={`Currency for ${country.name}`} value={currency} disabled={!canEdit} onChange={(e) => setCurrency(e.target.value)} className="w-56">
        <option value="">Usual: {country.currency ?? "none"}</option>
        {currencies.map((c) => (
          <option key={c.code} value={c.code}>
            {c.code} — {c.name}
          </option>
        ))}
      </Select>
      <Input aria-label={`Language for ${country.name}`} list="config-languages" value={language} disabled={!canEdit} onChange={(e) => setLanguage(e.target.value)} placeholder={`Usual: ${country.language ?? "—"}`} className="w-44" />
      {canEdit ? (
        <Button size="sm" variant="secondary" disabled={pending || (currency === (saved?.currency ?? "") && language === (saved?.language ?? ""))} onClick={() => run(() => saveCountrySetting({ country: country.code, favorite, currency: currency || null, language: language || null }))}>
          Save
        </Button>
      ) : null}
    </li>
  );
}

// ── Languages ───────────────────────────────────────────────────────────────────────────────────

function LanguagesTab({ languages, countries }: { languages: string[]; countries: Props["countries"] }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = languages.filter((l) => !q || l.toLowerCase().includes(q));
  return (
    <Card className="space-y-3 p-4!">
      <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">
        Every client has a primary language and may have more (Add / Edit Client → Add another language). A client&apos;s country suggests one; change the suggestion for a country on the Countries tab. These are the languages offered:
      </p>
      <SearchBox value={query} onChange={setQuery} label="Search languages" />
      <ul className="grid max-h-[60vh] grid-cols-2 gap-x-4 gap-y-1 overflow-y-auto text-[13px] sm:grid-cols-3 lg:grid-cols-4">
        {shown.map((l) => (
          <li key={l}>
            {l}
            <span className="ml-1 text-[11px] text-[color:var(--color-muted-foreground)]">{countries.filter((c) => c.language === l).length || ""}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
