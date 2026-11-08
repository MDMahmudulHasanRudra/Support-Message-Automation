"use client";

import { useMemo, useState, useTransition } from "react";
import { Archive, Download, Megaphone, RotateCcw, Tag, Trash2 } from "lucide-react";
import { CONTACT_CONSENT_LABEL, CONTACT_SOURCE_LABEL } from "@support-automation/shared";
import { Badge, Button, Dialog, Field, Input, RowMenu, useToast } from "@/components/ui";
import Link, { useProjectHref, useProjectRouter } from "@/components/ProjectLink";
import { ContactAvatar, KIND_ICON, WhatsAppMark } from "@/components/contacts/contactDisplay";
import { bulkUpdateContacts, type ContactBulkOp } from "@/server/actions/contacts";
import type { ContactFilters, ContactListRow } from "@/server/contacts";
import { NewCampaignDialog } from "./campaigns/NewCampaignDialog";

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dhaka" });

export function ContactsTable({ rows, total, filters, canEdit, canDelete, canExport, canCampaign, knownTags }: { rows: ContactListRow[]; total: number; filters: ContactFilters; canEdit: boolean; canDelete: boolean; canExport: boolean; canCampaign: boolean; knownTags: string[] }) {
  const router = useProjectRouter();
  const toProject = useProjectHref();
  const { showToast } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [pending, start] = useTransition();
  const [tagging, setTagging] = useState<"addTag" | "removeTag" | null>(null);
  const [tag, setTag] = useState("");
  const [campaign, setCampaign] = useState(false);
  const canSelect = canEdit || canExport || canCampaign;

  const pageIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const pageAll = pageIds.every((id) => selected.has(id));
  const count = allMatching ? total : selected.size;
  const selection = useMemo(() => (allMatching ? { filters: filters as unknown as Record<string, unknown> } : { ids: [...selected] }), [allMatching, filters, selected]);

  const clear = () => {
    setSelected(new Set());
    setAllMatching(false);
  };
  const toggle = (id: string) => {
    setAllMatching(false);
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setAllMatching(false);
    setSelected((s) => {
      const next = new Set(s);
      for (const id of pageIds) {
        if (pageAll) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const bulk = (op: ContactBulkOp, done: (n: number) => string) =>
    start(async () => {
      const r = await bulkUpdateContacts(selection, op);
      if ("error" in r) {
        showToast({ tone: "danger", title: r.error });
        return;
      }
      showToast({ tone: "success", title: done(r.changed) });
      setTagging(null);
      setTag("");
      clear();
      router.refresh();
    });

  const exportFile = (format: "xlsx" | "csv") =>
    start(async () => {
      const res = await fetch(toProject("/api/contacts/export"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...("ids" in selection ? { ids: selection.ids } : { filters: filters }), format }) });
      if (!res.ok) {
        showToast({ tone: "danger", title: (await res.text()) || "The export failed." });
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `contacts.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    });

  return (
    <>
      {count > 0 ? (
        <div className="sticky top-2 z-20 mb-2 flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 shadow-sm">
          <span className="tabular text-[13px] font-semibold">{count.toLocaleString("en-US")} selected</span>
          {pageAll && !allMatching && total > rows.length ? (
            <button type="button" className="link text-[12.5px]" onClick={() => setAllMatching(true)}>
              Select all {total.toLocaleString("en-US")} that match
            </button>
          ) : null}
          <span className="flex-1" />
          {canCampaign && !filters.archived ? (
            <Button size="sm" onClick={() => setCampaign(true)}>
              <Megaphone className="size-3.5" aria-hidden />
              Campaign
            </Button>
          ) : null}
          {canEdit ? (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => setTagging("addTag")}>
              <Tag className="size-3.5" aria-hidden />
              Tag
            </Button>
          ) : null}
          <RowMenu
            horizontal
            label="More actions"
            items={[
              { label: "Export Excel", icon: <Download className="size-3.5" />, onSelect: () => exportFile("xlsx"), hidden: !canExport },
              { label: "Export CSV", icon: <Download className="size-3.5" />, onSelect: () => exportFile("csv"), hidden: !canExport },
              { label: "Remove a tag", onSelect: () => setTagging("removeTag"), hidden: !canEdit },
              { label: "Agreed to offers", onSelect: () => bulk({ op: "consent", consent: "OPTED_IN" }, (n) => `${n} marked as agreed`), hidden: !canEdit },
              { label: "No offers", onSelect: () => bulk({ op: "consent", consent: "OPTED_OUT" }, (n) => `${n} marked as no offers`), hidden: !canEdit },
              { label: "Archive", icon: <Archive className="size-3.5" />, onSelect: () => bulk({ op: "archive" }, (n) => `${n} archived`), hidden: !canEdit || filters.archived },
              { label: "Restore", icon: <RotateCcw className="size-3.5" />, onSelect: () => bulk({ op: "restore" }, (n) => `${n} restored`), hidden: !canEdit || !filters.archived },
              {
                label: "Delete for good",
                icon: <Trash2 className="size-3.5" />,
                danger: true,
                hidden: !canDelete || !filters.archived,
                onSelect: () => {
                  if (window.confirm(`Delete ${count.toLocaleString("en-US")} contacts for good? This cannot be undone.`)) bulk({ op: "delete" }, (n) => `${n} deleted`);
                },
              },
            ]}
          />
          <Button size="sm" variant="ghost" onClick={clear}>
            Clear
          </Button>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="hidden items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-3.5 py-2 text-[12px] font-medium text-[color:var(--color-muted-foreground)] md:grid md:grid-cols-[1.25rem_minmax(0,1.3fr)_minmax(0,1.5fr)_minmax(0,1fr)_7.5rem]">
          {canSelect ? <input type="checkbox" aria-label="Select this page" checked={pageAll} onChange={toggleAll} className="size-4" /> : <span />}
          <span>Contact</span>
          <span>Reach them on</span>
          <span>Source and tags</span>
          <span className="text-right">Last contacted</span>
        </div>
        <ul className="divide-y divide-[var(--color-border)]">
          {rows.map((c) => {
            const shown = c.values.slice(0, 3);
            return (
              <li key={c.id} className="relative grid grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 px-3.5 py-2.5 transition-colors hover:bg-[var(--color-neutral-bg)]/60 md:grid-cols-[1.25rem_minmax(0,1.3fr)_minmax(0,1.5fr)_minmax(0,1fr)_7.5rem]">
                {canSelect ? <input type="checkbox" aria-label={`Select ${c.name}`} checked={allMatching || selected.has(c.id)} onChange={() => toggle(c.id)} className="relative z-10 size-4" /> : <span />}
                <div className="flex min-w-0 items-center gap-2.5">
                  <ContactAvatar name={c.name} />
                  <div className="min-w-0">
                    <Link href={`/contacts/${c.id}`} className="block truncate text-[14px] font-semibold text-[color:var(--color-foreground)] after:absolute after:inset-0 hover:underline">
                      {c.name}
                    </Link>
                    <p className="truncate text-[12.5px] text-[color:var(--color-muted-foreground)]">
                      <span className="tabular">{c.label}</span>
                      {c.code ? ` · ${c.code}` : ""}
                      {c.company ? ` · ${c.company}` : ""}
                    </p>
                  </div>
                </div>
                <div className="col-start-2 min-w-0 md:col-start-auto">
                  {shown.length === 0 ? <span className="text-[12.5px] text-[color:var(--color-subtle-foreground)]">Nothing yet</span> : null}
                  <ul className="space-y-0.5">
                    {shown.map((v) => {
                      const Icon = KIND_ICON[v.kind];
                      return (
                        <li key={v.id} className="flex min-w-0 items-center gap-1.5 text-[13px]">
                          <Icon className="size-3.5 shrink-0 text-[color:var(--color-muted-foreground)]" aria-hidden />
                          <span className="truncate">{v.value}</span>
                          {v.isWhatsApp ? <WhatsAppMark /> : null}
                        </li>
                      );
                    })}
                  </ul>
                  {c.values.length > shown.length ? <p className="mt-0.5 text-[12px] text-[color:var(--color-muted-foreground)]">+{c.values.length - shown.length} more</p> : null}
                </div>
                <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-1.5 md:col-start-auto">
                  <span className="text-[12.5px] text-[color:var(--color-muted-foreground)]">
                    {CONTACT_SOURCE_LABEL[c.source]}
                    {c.collectedByAi ? " · AI" : ""}
                  </span>
                  {c.consent !== "UNKNOWN" ? <Badge color={c.consent === "OPTED_IN" ? "green" : "red"}>{CONTACT_CONSENT_LABEL[c.consent]}</Badge> : null}
                  {c.linkedClient ? <Badge color="blue">Client</Badge> : null}
                  {c.tags.slice(0, 3).map((t) => (
                    <Badge key={t} color="gray">
                      {t}
                    </Badge>
                  ))}
                </div>
                <div className="col-start-2 text-[12.5px] text-[color:var(--color-muted-foreground)] md:col-start-auto md:text-right">{c.lastContactedAt ? DATE.format(new Date(c.lastContactedAt)) : <span className="md:hidden">Not contacted yet</span>}</div>
              </li>
            );
          })}
        </ul>
      </div>

      <Dialog open={tagging !== null} onClose={() => setTagging(null)} title={tagging === "removeTag" ? "Remove a tag" : "Add a tag"} description={`${count.toLocaleString("en-US")} selected`}>
        <form
          className="space-y-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (tag.trim() && tagging) bulk({ op: tagging, tag: tag.trim() }, (n) => `${n} changed`);
          }}
        >
          <Field label="Tag">
            <Input value={tag} onChange={(e) => setTag(e.target.value)} list="contact-tags" maxLength={40} autoFocus placeholder="For example: Eid offer" />
            <datalist id="contact-tags">
              {knownTags.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setTagging(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !tag.trim()}>
              {tagging === "removeTag" ? "Remove" : "Add"}
            </Button>
          </div>
        </form>
      </Dialog>

      {campaign ? <NewCampaignDialog open onClose={() => setCampaign(false)} selection={selection} count={count} knownTags={knownTags} /> : null}
    </>
  );
}
