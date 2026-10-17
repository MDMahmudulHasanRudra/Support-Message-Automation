"use client";

import { useMemo, useState, useTransition, type ReactNode } from "react";
import { Eye, MessageCircle, RefreshCw, Users, Wallet } from "lucide-react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import Link, { useProjectHref } from "@/components/ProjectLink";
import { Alert, Badge, Button, Checkbox, ConfirmDialog, Dialog, Field, Input, Select, SelectAllMatchingNotice } from "@/components/ui";
import {
  archiveClients,
  bulkAssignClients,
  bulkSetClientDetails,
  bulkSetClientStatus,
  bulkTagClients,
  deleteClients,
  restoreClients,
  selectAllMatchingClientIds,
  type BulkClientResult,
} from "@/server/actions/clients";
import type { ClientListRow } from "@/server/clients";
import {
  clientDisplayName,
  CLIENT_SOURCE_LABELS,
  CLIENT_STATUS_LABELS,
  describeDuration,
  SUBSCRIPTION_KIND_LABELS,
  SUBSCRIPTION_STATE_LABELS,
  type ClientSourceValue,
  type SubscriptionKind,
} from "@support-automation/shared";
import { countryName } from "@/lib/clientPhone";
import { expiryTextClass, formatDay, groupChatHref, money, SUBSCRIPTION_TONE } from "@/lib/clientDisplay";
import { ClientAvatar } from "./ClientAvatar";

export type ClientTableRow = ClientListRow;

type Pending =
  | { kind: "archive" | "restore" | "delete" }
  | { kind: "status"; status: string }
  | { kind: "assign"; memberId: string | null; label: string }
  | { kind: "tags"; add: string; remove: string };

const STATUS_COLOR: Record<string, "green" | "gray" | "yellow" | "red" | "blue"> = { ACTIVE: "green", INACTIVE: "gray", PENDING: "yellow", ARCHIVED: "gray", BLOCKED: "red" };
const BULK_STATUSES = ["ACTIVE", "INACTIVE", "PENDING", "BLOCKED"] as const;
const muted = "text-[color:var(--color-muted-foreground)]";
const Sub = ({ children }: { children: ReactNode }) => <div className={`mt-0.5 text-xs ${muted}`}>{children}</div>;
const None = ({ children = "—" }: { children?: ReactNode }) => <span className={muted}>{children}</span>;

export interface BulkOptions {
  teams: Array<{ id: string; name: string }>;
  sellers: Array<{ id: string; name: string }>;
  countries: Array<{ code: string; name: string }>;
  currencies: string[];
}

export interface RegisterCaps {
  canUpdate: boolean;
  canArchive: boolean;
  canDelete: boolean;
  canExport: boolean;
  canManageSubscriptions: boolean;
  canRecordPayments: boolean;
  canLinkGroups: boolean;
  canOpenChat: boolean;
}

function primaryPhone(c: ClientTableRow) {
  return c.channels.find((ch) => ch.kind === "WHATSAPP") ?? c.channels.find((ch) => ch.kind === "PHONE") ?? null;
}

/** One cell of the register. Every value here was already authorised on the server. */
function cell(key: string, c: ClientTableRow, caps: RegisterCaps): ReactNode {
  const sub = c.subscription;
  switch (key) {
    case "country":
      return c.country ? (
        <>
          <div className="whitespace-nowrap font-medium">
            {countryName(c.country)}
          </div>
          <Sub>{c.preferredCurrency ?? "No currency set"}</Sub>
        </>
      ) : (
        <None>Not set</None>
      );
    case "phone": {
      const p = primaryPhone(c);
      return p ? (
        <>
          <div className="whitespace-nowrap font-medium tabular">{p.value}</div>
          <Sub>{c.chatLinked ? "WhatsApp chat linked" : p.kind === "WHATSAPP" ? "WhatsApp number" : "Phone"}</Sub>
        </>
      ) : (
        <None>No number</None>
      );
    }
    case "service":
      return sub ? (
        <>
          <div className="font-medium">{sub.service}</div>
          <Sub>{SUBSCRIPTION_KIND_LABELS[sub.kind as SubscriptionKind] ?? sub.kind}</Sub>
        </>
      ) : (
        <None>No subscription</None>
      );
    case "expiry":
      return sub ? (
        <>
          <div className={`whitespace-nowrap font-medium ${expiryTextClass(sub.state)}`}>{formatDay(sub.endDate)}</div>
          <Sub>{sub.expiryText}</Sub>
        </>
      ) : (
        <None />
      );
    case "subscription":
      return c.subscriptionState === "NONE" ? <None>None</None> : <Badge color={SUBSCRIPTION_TONE[c.subscriptionState]}>{SUBSCRIPTION_STATE_LABELS[c.subscriptionState]}</Badge>;
    case "outstanding":
      if (!c.billing) return <None />;
      return c.billing.outstanding.length ? (
        <div className="space-y-0.5">
          {c.billing.outstanding.map((o) => (
            <div key={o.currency} className={`whitespace-nowrap font-semibold tabular ${o.overdue ? "text-[color:var(--color-danger-fg)]" : "text-[color:var(--color-warning-fg)]"}`}>
              {money(o.remaining, o.currency)}
            </div>
          ))}
        </div>
      ) : (
        <Badge color="green">No outstanding</Badge>
      );
    case "soldBy":
      return c.soldBy ? (
        <>
          <div className="whitespace-nowrap font-medium">{c.soldBy.name}</div>
          {c.soldBy.detail ? <Sub>{c.soldBy.detail}</Sub> : null}
        </>
      ) : (
        <None>Not recorded</None>
      );
    case "whatsappGroup":
      return c.groups.length ? (
        <div className="space-y-1">
          {c.groups.slice(0, 2).map((g) => {
            const href = caps.canOpenChat ? groupChatHref(g.accountId, g.groupId) : null;
            const chip = (
              <span className={`inline-flex max-w-[200px] items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1 text-xs font-medium ring-1 ring-inset ${g.active ? "bg-[var(--color-success-bg)] text-[color:var(--color-success-fg)] ring-[var(--color-success-border)]" : "bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)] ring-[var(--color-neutral-border)]"}`}>
                <Users className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{g.name}</span>
              </span>
            );
            return (
              <div key={g.linkId}>
                {href ? (
                  <Link href={href} title="Open this group in WhatsApp Chat">
                    {chip}
                  </Link>
                ) : (
                  chip
                )}
                <Sub>{g.active ? (g.accountLabel ?? "Account removed") : "Group inactive on this number"}</Sub>
              </div>
            );
          })}
          {c.groups.length > 2 ? <Sub>+{c.groups.length - 2} more</Sub> : null}
        </div>
      ) : caps.canLinkGroups ? (
        <Link href={`/clients/${c.id}#whatsapp-groups`} className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-dashed border-[var(--color-border-strong)] px-2 py-1 text-xs text-[color:var(--color-muted-foreground)] hover:border-[var(--color-foreground)] hover:text-[color:var(--color-foreground)]">
          + Link group
        </Link>
      ) : (
        <None>Not linked</None>
      );
    case "email":
      return c.channels.find((ch) => ch.kind === "EMAIL")?.value ?? <None />;
    case "company":
      return c.companyName ?? <None />;
    case "address":
      return c.address ? <span className="line-clamp-2 max-w-[220px]">{c.address}</span> : <None />;
    case "currency":
      return c.preferredCurrency ?? <None />;
    case "assignedTeam":
      return c.assignedTeamName ?? <None />;
    case "assignedTo":
      return c.assignedMemberName ?? <None />;
    case "subscriptionStart":
      return sub ? formatDay(sub.startDate) : <None />;
    case "duration":
      return sub ? describeDuration(sub.durationValue, sub.durationUnit) : <None />;
    case "renewals":
      return c.subscriptionCount > 1 ? `${c.subscriptionCount - 1}` : c.subscriptionCount === 1 ? "0" : <None />;
    case "nextDue":
      return c.billing?.nextDueDate ? formatDay(c.billing.nextDueDate) : <None />;
    case "invoices":
      return c.billing ? String(c.billing.openInvoices) : <None />;
    case "category":
      return c.category ?? <None />;
    case "tags":
      return c.tags.length ? (
        <div className="flex max-w-[220px] flex-wrap gap-1">
          {c.tags.slice(0, 4).map((t) => (
            <Badge key={t} color="blue">
              {t}
            </Badge>
          ))}
          {c.tags.length > 4 ? <span className={`text-xs ${muted}`}>+{c.tags.length - 4}</span> : null}
        </div>
      ) : (
        <None />
      );
    case "source":
      return CLIENT_SOURCE_LABELS[c.source as ClientSourceValue] ?? c.source;
    case "status":
      return (
        <Badge color={STATUS_COLOR[c.status] ?? "gray"} dot>
          {CLIENT_STATUS_LABELS[c.status as keyof typeof CLIENT_STATUS_LABELS] ?? c.status}
        </Badge>
      );
    case "lastContact":
      return c.lastContactAt ? new Date(c.lastContactAt).toLocaleDateString("en-GB", { timeZone: "Asia/Dhaka" }) : <None>Never</None>;
    case "created":
      return new Date(c.createdAt).toLocaleDateString("en-GB", { timeZone: "Asia/Dhaka" });
    case "updated":
      return new Date(c.updatedAt).toLocaleDateString("en-GB", { timeZone: "Asia/Dhaka" });
    default:
      return null;
  }
}

function Identity({ c }: { c: ClientTableRow }) {
  return (
    <div className="flex min-w-[210px] items-center gap-3">
      <ClientAvatar id={c.id} code={c.code} name={c.name} companyName={c.companyName} photoVersion={c.photoVersion} />
      <div className="min-w-0">
        <Link className="block truncate font-semibold text-[color:var(--color-foreground)] hover:underline" href={`/clients/${c.id}`}>
          {clientDisplayName(c.name, c.companyName)}
        </Link>
        <div className={`flex items-center gap-1.5 text-xs ${muted}`}>
          <span className="font-[family-name:var(--font-mono)]">{c.code}</span>
          {c.returning ? (
            <span className="inline-flex items-center gap-0.5" title="Has renewed or bought again">
              · <RefreshCw className="size-3" aria-hidden /> Returning
            </span>
          ) : null}
          {c.status !== "ACTIVE" ? <span>· {CLIENT_STATUS_LABELS[c.status as keyof typeof CLIENT_STATUS_LABELS] ?? c.status}</span> : null}
        </div>
      </div>
    </div>
  );
}

function RowActions({ c, caps }: { c: ClientTableRow; caps: RegisterCaps }) {
  const group = c.groups.find((g) => g.active);
  const chat = caps.canOpenChat && group ? groupChatHref(group.accountId, group.groupId) : null;
  const icon = "inline-flex size-8 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]";
  return (
    <div className="flex items-center justify-end gap-0.5">
      <Link href={`/clients/${c.id}`} className={icon} title="Open the 360° view" aria-label={`Open ${clientDisplayName(c.name, c.companyName)}`}>
        <Eye className="size-4" />
      </Link>
      {caps.canManageSubscriptions ? (
        <Link href={`/clients/${c.id}#subscriptions`} className={icon} title={c.subscription ? "Renew or add a subscription" : "Add a subscription"} aria-label="Subscriptions">
          <RefreshCw className="size-4" />
        </Link>
      ) : null}
      {caps.canRecordPayments && c.billing?.openInvoices ? (
        <Link href={`/clients/dues?q=${encodeURIComponent(c.code)}`} className={icon} title="Record a payment" aria-label="Record a payment">
          <Wallet className="size-4" />
        </Link>
      ) : null}
      {chat ? (
        <Link href={chat} className={icon} title="Open the linked group in WhatsApp Chat" aria-label="Open WhatsApp group">
          <MessageCircle className="size-4" />
        </Link>
      ) : null}
    </div>
  );
}

/**
 * The register, with selection. A header checkbox selects THIS page; widening to every client matching
 * the filters is a separate, named click (SelectAllMatchingNotice), because the browser holds only the
 * rows on screen and a silent widening would be the most dangerous control in the app. Every bulk
 * action shows how many clients it will touch before it runs, and the destructive ones confirm.
 *
 * Desktop: a dense table with the identity column sticky while the rest scrolls sideways. Phones:
 * cards with the facts that matter at a glance and the same actions.
 */
export function ClientsTable({
  clients,
  total,
  filterParams,
  columns,
  columnLabels,
  caps,
  members,
  maxBulk,
  exportBase,
  bulkOptions,
}: {
  clients: ClientTableRow[];
  total: number;
  filterParams: Record<string, string>;
  columns: string[];
  columnLabels: Record<string, string>;
  caps: RegisterCaps;
  members: Array<{ id: string; name: string }>;
  maxBulk: number;
  exportBase: string;
  bulkOptions?: BulkOptions;
}) {
  const router = useRouter();
  const toProject = useProjectHref();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, startTransition] = useTransition();
  const [widening, setWidening] = useState(false);
  const [tagAdd, setTagAdd] = useState("");
  const [tagRemove, setTagRemove] = useState("");
  const [assignTo, setAssignTo] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [details, setDetails] = useState({ teamId: "", soldByMemberId: "", country: "", preferredCurrency: "" });

  function applyDetails() {
    const ids = [...selected];
    startTransition(async () => {
      const result = await bulkSetClientDetails(ids, details);
      setMessage({ ok: result.ok, text: result.message });
      if (result.ok) {
        setDetailsOpen(false);
        setDetails({ teamId: "", soldByMemberId: "", country: "", preferredCurrency: "" });
        clear();
      }
      router.refresh();
    });
  }
  const { canUpdate, canArchive, canDelete, canExport } = caps;

  const pageIds = useMemo(() => clients.map((c) => c.id), [clients]);
  const allVisible = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const anyVisible = pageIds.some((id) => selected.has(id));
  const showBulk = canUpdate || canArchive || canDelete || canExport;
  const archivedView = filterParams.status === "ARCHIVED";
  const dataColumns = columns.filter((k) => k !== "client");

  function toggleOne(id: string) {
    setAllMatching(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function togglePage() {
    setAllMatching(false);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of pageIds) {
        if (allVisible) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }
  async function selectEverything() {
    setWidening(true);
    const { ids, truncated } = await selectAllMatchingClientIds(filterParams);
    setWidening(false);
    setSelected(new Set(ids));
    setAllMatching(true);
    if (truncated) setMessage({ ok: false, text: `Only the first ${ids.length.toLocaleString()} could be selected at once. Narrow the filters and repeat for the rest.` });
  }
  function clear() {
    setSelected(new Set());
    setAllMatching(false);
  }

  function run() {
    if (!pending) return;
    const ids = [...selected];
    const action = pending;
    startTransition(async () => {
      let result: BulkClientResult;
      if (action.kind === "archive") result = await archiveClients(ids);
      else if (action.kind === "restore") result = await restoreClients(ids);
      else if (action.kind === "delete") result = await deleteClients(ids);
      else if (action.kind === "status") result = await bulkSetClientStatus(ids, action.status);
      else if (action.kind === "assign") result = await bulkAssignClients(ids, action.memberId, null);
      else if (action.kind === "tags") result = await bulkTagClients(ids, action.add, action.remove);
      else result = { ok: false, message: "Unknown action." };
      setMessage({ ok: result.ok, text: result.message });
      setPending(null);
      if (result.ok) clear();
      router.refresh();
    });
  }

  async function exportSelected(format: "xlsx" | "csv") {
    setMessage(null);
    const response = await fetch(toProject(exportBase), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [...selected], format }) });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setMessage({ ok: false, text: body?.error ?? "The export could not be created." });
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `clients.${format}`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const count = selected.size.toLocaleString();
  const confirmCopy: Record<Pending["kind"], { title: string; description: string; label: string; tone: "primary" | "danger" }> = {
    archive: { title: `Archive ${count} client(s)?`, description: "Archived clients are hidden from the default list. Their channels, notes and history are kept, and you can restore them.", label: "Archive", tone: "primary" },
    restore: { title: `Restore ${count} client(s)?`, description: "They return with the status they had when they were archived.", label: "Restore", tone: "primary" },
    delete: { title: `Permanently delete ${count} client(s)?`, description: "Each client is removed with everything that belongs to it: channels, notes, timeline, subscriptions, invoices, payments and WhatsApp links. This cannot be undone — Archive instead if you may need them again.", label: `Delete ${count} permanently`, tone: "danger" },
    status: { title: `Change the status of ${count} client(s)?`, description: pending?.kind === "status" ? `They will be set to ${CLIENT_STATUS_LABELS[pending.status as keyof typeof CLIENT_STATUS_LABELS] ?? pending.status}. Archived clients are skipped.` : "", label: "Change status", tone: "primary" },
    assign: { title: `Assign ${count} client(s)?`, description: pending?.kind === "assign" ? `To ${pending.label}. Archived clients are skipped.` : "", label: "Assign", tone: "primary" },
    tags: { title: `Update tags on ${count} client(s)?`, description: pending?.kind === "tags" ? `${pending.add ? `Add: ${pending.add}. ` : ""}${pending.remove ? `Remove: ${pending.remove}. ` : ""}Archived clients are skipped.` : "", label: "Update tags", tone: "primary" },
  };

  const th = "whitespace-nowrap border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-[color:var(--color-muted-foreground)]";
  const td = "border-b border-[var(--color-border)] px-4 py-3.5 align-middle text-[13px]";
  const sticky = "sticky z-[1] bg-[var(--color-surface)] group-hover:bg-[var(--color-surface-sunken)]";

  return (
    <div>
      {message ? (
        <div className="mb-3">
          <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert>
        </div>
      ) : null}

      {showBulk && selected.size > 0 ? (
        <div className="mb-3 space-y-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{count} selected</span>
            <span className={muted}>{allMatching ? "(everything matching these filters)" : `(of ${clients.length} on this page)`}</span>
            <Button variant="ghost" size="sm" onClick={clear} disabled={busy}>
              Clear
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            {canUpdate ? (
              <>
                <Select value="" onChange={(e) => e.target.value && setPending({ kind: "status", status: e.target.value })} className="sm:w-40" aria-label="Change status">
                  <option value="">Set status…</option>
                  {BULK_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {CLIENT_STATUS_LABELS[s]}
                    </option>
                  ))}
                </Select>
                <Select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} className="sm:w-44" aria-label="Assign to">
                  <option value="">Assign to…</option>
                  <option value="__none">Nobody (clear)</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!assignTo}
                  onClick={() => setPending({ kind: "assign", memberId: assignTo === "__none" ? null : assignTo, label: assignTo === "__none" ? "nobody (clearing the assignment)" : members.find((m) => m.id === assignTo)?.name ?? "that person" })}
                >
                  Assign
                </Button>
                <Input value={tagAdd} onChange={(e) => setTagAdd(e.target.value)} placeholder="Add tags" className="sm:w-36" aria-label="Tags to add" />
                <Input value={tagRemove} onChange={(e) => setTagRemove(e.target.value)} placeholder="Remove tags" className="sm:w-36" aria-label="Tags to remove" />
                <Button variant="secondary" size="sm" disabled={!tagAdd.trim() && !tagRemove.trim()} onClick={() => setPending({ kind: "tags", add: tagAdd, remove: tagRemove })}>
                  Update tags
                </Button>
                {bulkOptions ? (
                  <Button variant="secondary" size="sm" onClick={() => setDetailsOpen(true)}>
                    Set team, seller, country…
                  </Button>
                ) : null}
              </>
            ) : null}
            {canArchive && !archivedView ? (
              <Button variant="secondary" size="sm" onClick={() => setPending({ kind: "archive" })}>
                Archive
              </Button>
            ) : null}
            {canArchive && archivedView ? (
              <Button variant="secondary" size="sm" onClick={() => setPending({ kind: "restore" })}>
                Restore
              </Button>
            ) : null}
            {canDelete ? (
              <Button variant="danger" size="sm" onClick={() => setPending({ kind: "delete" })}>
                Delete
              </Button>
            ) : null}
            {canExport ? (
              <>
                <Button variant="secondary" size="sm" onClick={() => exportSelected("xlsx")}>
                  Export selected (Excel)
                </Button>
                <Button variant="secondary" size="sm" onClick={() => exportSelected("csv")}>
                  CSV
                </Button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {showBulk ? (
        <SelectAllMatchingNotice
          pageSelectedCount={clients.filter((c) => selected.has(c.id)).length}
          pageCount={clients.length}
          totalMatching={total}
          allMatchingSelected={allMatching}
          onSelectAllMatching={selectEverything}
          onClear={clear}
          loading={widening}
          noun={{ singular: "client", plural: "clients" }}
          max={maxBulk}
        />
      ) : null}

      {/* Desktop and tablet: the register. */}
      <div className="hidden overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xs),var(--highlight-top)] md:block">
        <table className="w-full border-separate border-spacing-0 text-left">
          <thead>
            <tr>
              {showBulk ? (
                <th className={`${th} sticky left-0 z-[2] w-10`}>
                  <Checkbox checked={allVisible} indeterminate={!allVisible && anyVisible} onChange={togglePage} aria-label="Select this page" />
                </th>
              ) : null}
              <th className={`${th} sticky z-[2] ${showBulk ? "left-10" : "left-0"} border-r`}>Client / ID</th>
              {dataColumns.map((k) => (
                <th key={k} className={th}>
                  {columnLabels[k] ?? k}
                </th>
              ))}
              <th className={`${th} text-right`}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id} className="group">
                {showBulk ? (
                  <td className={`${td} ${sticky} left-0 w-10`}>
                    <Checkbox checked={selected.has(c.id)} onChange={() => toggleOne(c.id)} aria-label={`Select ${clientDisplayName(c.name, c.companyName)}`} />
                  </td>
                ) : null}
                <td className={`${td} ${sticky} ${showBulk ? "left-10" : "left-0"} border-r`}>
                  <Identity c={c} />
                </td>
                {dataColumns.map((k) => (
                  <td key={k} className={`${td} group-hover:bg-[var(--color-surface-sunken)]`}>
                    {cell(k, c, caps)}
                  </td>
                ))}
                <td className={`${td} group-hover:bg-[var(--color-surface-sunken)]`}>
                  <RowActions c={c} caps={caps} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phones: one card per client, primary facts first. */}
      <ul className="space-y-3 md:hidden">
        {clients.map((c) => {
          const p = primaryPhone(c);
          return (
            <li key={c.id} className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)]">
              <div className="flex items-start gap-3">
                {showBulk ? <Checkbox className="mt-3" checked={selected.has(c.id)} onChange={() => toggleOne(c.id)} aria-label={`Select ${clientDisplayName(c.name, c.companyName)}`} /> : null}
                <div className="min-w-0 flex-1">
                  <Identity c={c} />
                </div>
                {c.subscriptionState !== "NONE" ? <Badge color={SUBSCRIPTION_TONE[c.subscriptionState]}>{SUBSCRIPTION_STATE_LABELS[c.subscriptionState]}</Badge> : null}
              </div>
              <p className={`mt-2 truncate text-xs ${muted}`}>
                {[c.country ? (countryName(c.country) ?? c.country) : null, p?.value].filter(Boolean).join(" · ") || "No country or number yet"}
              </p>
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-3 text-[13px]">
                <div>
                  <dt className={`text-[11px] ${muted}`}>Current service</dt>
                  <dd className="font-medium">{c.subscription?.service ?? "—"}</dd>
                </div>
                <div>
                  <dt className={`text-[11px] ${muted}`}>Expiry</dt>
                  <dd className={`font-medium ${c.subscription ? expiryTextClass(c.subscription.state) : ""}`}>{c.subscription ? formatDay(c.subscription.endDate) : "—"}</dd>
                </div>
                {c.billing ? (
                  <div>
                    <dt className={`text-[11px] ${muted}`}>Outstanding</dt>
                    <dd className="font-medium">{c.billing.outstanding.length ? c.billing.outstanding.map((o) => money(o.remaining, o.currency)).join(" · ") : "None"}</dd>
                  </div>
                ) : null}
                <div>
                  <dt className={`text-[11px] ${muted}`}>Seller / team</dt>
                  <dd className="font-medium">{c.soldBy ? `${c.soldBy.name}${c.soldBy.detail ? ` · ${c.soldBy.detail}` : ""}` : "—"}</dd>
                </div>
              </dl>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Link href={`/clients/${c.id}`} className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 text-sm font-medium">
                  <Eye className="size-4" aria-hidden /> View profile
                </Link>
                {c.groups[0] && caps.canOpenChat && groupChatHref(c.groups[0].accountId, c.groups[0].groupId) ? (
                  <Link href={groupChatHref(c.groups[0].accountId, c.groups[0].groupId)!} className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 text-sm font-medium">
                    <MessageCircle className="size-4" aria-hidden /> WhatsApp group
                  </Link>
                ) : caps.canLinkGroups ? (
                  <Link href={`/clients/${c.id}#whatsapp-groups`} className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-strong)] px-3 text-sm font-medium">
                    <Users className="size-4" aria-hidden /> Link WhatsApp
                  </Link>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {bulkOptions ? (
        <Dialog
          open={detailsOpen}
          onClose={() => setDetailsOpen(false)}
          title={`Set details for ${count} client(s)`}
          description="Only what you choose is changed; everything left on “Keep as is” stays. Archived clients are skipped."
          footer={
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setDetailsOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="button" onClick={applyDetails} loading={busy} disabled={!Object.values(details).some(Boolean)}>
                Apply to {count}
              </Button>
            </div>
          }
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Team" hint="An assigned staff member outside the new team is cleared.">
              <Select value={details.teamId} onChange={(e) => setDetails((d) => ({ ...d, teamId: e.target.value }))}>
                <option value="">Keep as is</option>
                <option value="__none">No team</option>
                {bulkOptions.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Sold by">
              <Select value={details.soldByMemberId} onChange={(e) => setDetails((d) => ({ ...d, soldByMemberId: e.target.value }))}>
                <option value="">Keep as is</option>
                <option value="__none">Not recorded</option>
                {bulkOptions.sellers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Country">
              <Select value={details.country} onChange={(e) => setDetails((d) => ({ ...d, country: e.target.value }))}>
                <option value="">Keep as is</option>
                <option value="__none">Not set</option>
                {bulkOptions.countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Preferred currency">
              <Select value={details.preferredCurrency} onChange={(e) => setDetails((d) => ({ ...d, preferredCurrency: e.target.value }))}>
                <option value="">Keep as is</option>
                <option value="__none">None</option>
                {bulkOptions.currencies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Dialog>
      ) : null}

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={run}
        loading={busy}
        tone={pending ? confirmCopy[pending.kind].tone : "primary"}
        title={pending ? confirmCopy[pending.kind].title : ""}
        description={pending ? confirmCopy[pending.kind].description : undefined}
        confirmLabel={pending ? confirmCopy[pending.kind].label : "Confirm"}
      />
    </div>
  );
}
