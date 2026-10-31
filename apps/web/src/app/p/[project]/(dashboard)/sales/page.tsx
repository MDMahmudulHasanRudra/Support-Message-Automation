import Link from "@/components/ProjectLink";
import { SavedViewsBar } from "@/components/SavedViewsBar";
import { loadSavedViews } from "@/server/listSavedViewsReader";
import { sanitizeViewQuery } from "@/lib/listSavedViews";
import { Plus } from "lucide-react";
import { LEAD_SOURCE_LABELS, LEAD_STAGE_LABELS, LEAD_STAGES, OPEN_LEAD_STAGES, type LeadSource, type LeadStage } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { listLeads } from "@/server/commerce";
import { ButtonLink, PageHeader, SearchField, StatTile, ViewOnlyNotice } from "@/components/ui";

export const metadata = { title: "Sales pipeline" };

const day = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** The pipeline as columns, one per stage. Won and Lost are shown only on request: they are closed. */
export default async function SalesPage({ searchParams }: { searchParams: Promise<{ search?: string; closed?: string }> }) {
  const { canManage, session } = await pageAccess("sales.view", "sales.manage");
  const sp = await searchParams;
  const savedViews = await loadSavedViews("/sales", session.userId);
  const currentQuery = sanitizeViewQuery("/sales", sp);
  const includeClosed = sp.closed === "1";
  const leads = await listLeads({ q: sp.search, includeClosed });
  const stages: readonly LeadStage[] = includeClosed ? LEAD_STAGES : OPEN_LEAD_STAGES;
  const byStage = new Map<LeadStage, typeof leads>(stages.map((s) => [s, []]));
  for (const l of leads) byStage.get(l.stage)?.push(l);
  const open = leads.filter((l) => l.stage !== "WON" && l.stage !== "LOST");
  const overdue = open.filter((l) => l.overdue).length;
  const closedLink = new URLSearchParams();
  if (sp.search) closedLink.set("search", sp.search);
  if (!includeClosed) closedLink.set("closed", "1");

  return (
    <div>
      <PageHeader
        title="Sales pipeline"
        description="People who might buy, from first message to order. Move each along as you talk; an order made from a lead closes it as won."
        actions={
          canManage ? (
            <ButtonLink href="/sales/new" variant="primary" size="md">
              <Plus className="size-4" aria-hidden /> New lead
            </ButtonLink>
          ) : null
        }
      />
      {canManage ? null : <ViewOnlyNotice />}
      <SavedViewsBar page="/sales" views={savedViews} currentQuery={currentQuery} canShare={canManage} />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatTile label="Open leads" value={open.length} />
        <StatTile label="Follow-up overdue" value={overdue} tone={overdue ? "warning" : "neutral"} />
        <StatTile label="In proposal" value={byStage.get("PROPOSAL")?.length ?? 0} />
      </div>

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <Link className="link text-sm" href={`/sales${closedLink.toString() ? `?${closedLink}` : ""}`}>
          {includeClosed ? "Hide won and lost" : "Show won and lost"}
        </Link>
        <SearchField placeholder="Name, phone or company" defaultValue={sp.search ?? ""} preserve={{ closed: includeClosed ? "1" : undefined }} />
      </div>

      <div className="flex gap-3 overflow-x-auto pb-2">
        {stages.map((stage) => {
          const cards = byStage.get(stage) ?? [];
          return (
            <section key={stage} className="flex w-72 shrink-0 flex-col rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-neutral-bg)]">
              <header className="flex items-center justify-between px-3 py-2 text-sm font-semibold">
                {LEAD_STAGE_LABELS[stage]}
                <span className="tabular text-xs text-[color:var(--color-muted-foreground)]">{cards.length}</span>
              </header>
              <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto px-2 pb-2">
                {cards.length === 0 ? <p className="px-1 py-3 text-xs text-[color:var(--color-muted-foreground)]">None</p> : null}
                {cards.map((l) => (
                  <Link key={l.id} href={`/sales/${l.id}`} className="block rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm shadow-[var(--shadow-xs)] hover:border-[var(--color-border-strong)]">
                    <p className="font-medium">{l.name}</p>
                    {l.company ? <p className="text-xs text-[color:var(--color-muted-foreground)]">{l.company}</p> : null}
                    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[color:var(--color-muted-foreground)]">
                      <span>{LEAD_SOURCE_LABELS[l.source as LeadSource] ?? l.source}</span>
                      {l.value ? <span className="tabular text-[color:var(--color-foreground)]">{l.value}</span> : null}
                      {l.clientName ? <span>· {l.clientName}</span> : null}
                    </div>
                    {l.nextFollowUpAt ? (
                      <p className={`mt-1 text-xs ${l.overdue ? "font-medium text-[color:var(--color-danger)]" : "text-[color:var(--color-muted-foreground)]"}`}>
                        {l.overdue ? "Overdue: " : "Follow up "}
                        {day(l.nextFollowUpAt)}
                      </p>
                    ) : null}
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
