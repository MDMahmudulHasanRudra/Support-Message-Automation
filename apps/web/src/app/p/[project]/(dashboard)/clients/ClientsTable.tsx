"use client";

import { useMemo, useState, useTransition } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import Link, { useProjectHref } from "@/components/ProjectLink";
import { Alert, Badge, Button, Checkbox, ConfirmDialog, Input, Select, SelectAllMatchingNotice, Table, Td, Th } from "@/components/ui";
import {
  archiveClients,
  bulkAssignClients,
  bulkSetClientStatus,
  bulkTagClients,
  deleteClients,
  restoreClients,
  selectAllMatchingClientIds,
  type BulkClientResult,
} from "@/server/actions/clients";
import { CLIENT_CHANNEL_LABELS, CLIENT_STATUS_LABELS, type ClientChannelKindValue } from "@support-automation/shared";

export interface ClientTableRow {
  id: string;
  code: string;
  name: string;
  companyName: string | null;
  status: string;
  category: string | null;
  tags: string[];
  assignedMemberName: string | null;
  lastContact: string | null;
  channels: Array<{ kind: string; value: string; isPrimary: boolean }>;
}

type Pending =
  | { kind: "archive" | "restore" | "delete" }
  | { kind: "status"; status: string }
  | { kind: "assign"; memberId: string | null; label: string }
  | { kind: "tags"; add: string; remove: string };

const STATUS_COLOR: Record<string, "green" | "gray" | "yellow" | "red" | "blue"> = { ACTIVE: "green", INACTIVE: "gray", PENDING: "yellow", ARCHIVED: "gray", BLOCKED: "red" };
const BULK_STATUSES = ["ACTIVE", "INACTIVE", "PENDING", "BLOCKED"] as const;

/**
 * The list, with selection. A header checkbox selects THIS page; widening to every client matching
 * the filters is a separate, named click (SelectAllMatchingNotice), because the browser holds only
 * the rows on screen and a silent widening would be the most dangerous control in the app. Every
 * bulk action shows how many clients it will touch before it runs, and the destructive ones confirm.
 */
export function ClientsTable({
  clients,
  total,
  filterParams,
  canUpdate,
  canArchive,
  canDelete,
  canExport,
  members,
  maxBulk,
  exportBase,
}: {
  clients: ClientTableRow[];
  total: number;
  filterParams: Record<string, string>;
  canUpdate: boolean;
  canArchive: boolean;
  canDelete: boolean;
  canExport: boolean;
  members: Array<{ id: string; name: string }>;
  maxBulk: number;
  exportBase: string;
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

  const pageIds = useMemo(() => clients.map((c) => c.id), [clients]);
  const allVisible = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const anyVisible = pageIds.some((id) => selected.has(id));
  const showBulk = canUpdate || canArchive || canDelete || canExport;
  const archivedView = filterParams.status === "ARCHIVED";

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
    delete: { title: `Permanently delete ${count} client(s)?`, description: "Only archived clients are deleted; others are skipped. Their channels, notes and timeline go with them. This cannot be undone.", label: "Delete permanently", tone: "danger" },
    status: { title: `Change the status of ${count} client(s)?`, description: pending?.kind === "status" ? `They will be set to ${CLIENT_STATUS_LABELS[pending.status as keyof typeof CLIENT_STATUS_LABELS] ?? pending.status}. Archived clients are skipped.` : "", label: "Change status", tone: "primary" },
    assign: { title: `Assign ${count} client(s)?`, description: pending?.kind === "assign" ? `To ${pending.label}. Archived clients are skipped.` : "", label: "Assign", tone: "primary" },
    tags: { title: `Update tags on ${count} client(s)?`, description: pending?.kind === "tags" ? `${pending.add ? `Add: ${pending.add}. ` : ""}${pending.remove ? `Remove: ${pending.remove}. ` : ""}Archived clients are skipped.` : "", label: "Update tags", tone: "primary" },
  };

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
            <span className="text-[color:var(--color-muted-foreground)]">{allMatching ? "(everything matching these filters)" : `(of ${clients.length} on this page)`}</span>
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
            {canDelete && archivedView ? (
              <Button variant="danger" size="sm" onClick={() => setPending({ kind: "delete" })}>
                Delete permanently
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

      <Table>
        <thead>
          <tr>
            {showBulk ? (
              <Th>
                <Checkbox checked={allVisible} indeterminate={!allVisible && anyVisible} onChange={togglePage} aria-label="Select this page" />
              </Th>
            ) : null}
            <Th>Client</Th>
            <Th>Contact</Th>
            <Th>Category &amp; tags</Th>
            <Th>Assigned</Th>
            <Th>Last contact</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => (
            <tr key={c.id}>
              {showBulk ? (
                <Td>
                  <Checkbox checked={selected.has(c.id)} onChange={() => toggleOne(c.id)} aria-label={`Select ${c.name}`} />
                </Td>
              ) : null}
              <Td>
                <Link className="link font-medium" href={`/clients/${c.id}`}>
                  {c.name}
                </Link>
                <div className="text-xs text-[color:var(--color-muted-foreground)]">
                  <span className="font-[family-name:var(--font-mono)]">{c.code}</span>
                  {c.companyName ? ` · ${c.companyName}` : ""}
                </div>
              </Td>
              <Td>
                {c.channels.length ? (
                  <ul className="space-y-0.5 text-[13px]">
                    {c.channels.slice(0, 3).map((ch, i) => (
                      <li key={i} className="truncate" title={CLIENT_CHANNEL_LABELS[ch.kind as ClientChannelKindValue]}>
                        <span className="text-[color:var(--color-muted-foreground)]">{CLIENT_CHANNEL_LABELS[ch.kind as ClientChannelKindValue] ?? ch.kind}: </span>
                        {ch.value}
                      </li>
                    ))}
                    {c.channels.length > 3 ? <li className="text-xs text-[color:var(--color-muted-foreground)]">+{c.channels.length - 3} more</li> : null}
                  </ul>
                ) : (
                  <span className="text-[color:var(--color-muted-foreground)]">No channels</span>
                )}
              </Td>
              <Td>
                {c.category ? <div className="text-[13px]">{c.category}</div> : null}
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {c.tags.slice(0, 4).map((t) => (
                    <Badge key={t} color="blue">
                      {t}
                    </Badge>
                  ))}
                  {c.tags.length > 4 ? <span className="text-xs text-[color:var(--color-muted-foreground)]">+{c.tags.length - 4}</span> : null}
                </div>
              </Td>
              <Td>{c.assignedMemberName ?? <span className="text-[color:var(--color-muted-foreground)]">—</span>}</Td>
              <Td>{c.lastContact ?? <span className="text-[color:var(--color-muted-foreground)]">Never</span>}</Td>
              <Td>
                <Badge color={STATUS_COLOR[c.status] ?? "gray"} dot>
                  {CLIENT_STATUS_LABELS[c.status as keyof typeof CLIENT_STATUS_LABELS] ?? c.status}
                </Badge>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

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
