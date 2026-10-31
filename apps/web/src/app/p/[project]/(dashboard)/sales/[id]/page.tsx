import { notFound } from "next/navigation";
import Link from "@/components/ProjectLink";
import { fromMinor, LEAD_SOURCE_LABELS, LEAD_STAGE_LABELS, type LeadSource, type LeadStage } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { clientOptions, getLead } from "@/server/commerce";
import { Badge, ButtonLink, Card, PageHeader, SectionHeader, ViewOnlyNotice } from "@/components/ui";
import { LeadForm } from "../LeadForm";
import { LeadNoteForm, LeadStageControls } from "./LeadActions";

export const metadata = { title: "Lead" };

const when = (d: string | Date) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(d));

/** `datetime-local` wants the Dhaka wall-clock time, without a zone. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}`;
}

function describe(e: { kind: string; fromStage: string | null; toStage: string | null; note: string | null }): string {
  switch (e.kind) {
    case "CREATED":
      return "Lead added";
    case "EDITED":
      return "Details edited";
    case "STAGE":
      return `${LEAD_STAGE_LABELS[e.fromStage as LeadStage] ?? e.fromStage} → ${LEAD_STAGE_LABELS[e.toStage as LeadStage] ?? e.toStage}${e.note ? ` · ${e.note}` : ""}`;
    case "FOLLOW_UP":
      return e.note === "cleared" ? "Follow-up cleared" : `Follow-up set for ${e.note ? when(e.note) : ""}`;
    case "NOTE":
      return e.note ?? "";
    default:
      return e.kind;
  }
}

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { canManage } = await pageAccess("sales.view", "sales.manage");
  const { id } = await params;
  const [lead, clients] = await Promise.all([getLead(id), clientOptions()]);
  if (!lead) notFound();
  const stage = lead.stage as LeadStage;

  return (
    <div>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {lead.name}
            <Badge color={stage === "WON" ? "green" : stage === "LOST" ? "red" : "blue"} dot>
              {LEAD_STAGE_LABELS[stage]}
            </Badge>
          </span>
        }
        description={`${LEAD_SOURCE_LABELS[lead.source as LeadSource] ?? lead.source} lead, added ${when(lead.createdAt)} by ${lead.createdByUsername}.${lead.lostReason ? ` Lost: ${lead.lostReason}` : ""}`}
        actions={<ButtonLink href="/sales">Pipeline</ButtonLink>}
      />
      {canManage ? null : <ViewOnlyNotice />}
      {lead.wonOrder ? (
        <p className="mb-4 text-sm">
          Became order{" "}
          <Link className="link font-medium" href={`/commerce/orders/${lead.wonOrder.id}`}>
            {lead.wonOrder.number}
          </Link>
          .
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[3fr_2fr]">
        <div className="space-y-6">
          {canManage ? (
            <Card>
              <SectionHeader title="Move" />
              <LeadStageControls leadId={lead.id} stage={stage} hasOrder={Boolean(lead.wonOrder)} />
            </Card>
          ) : null}
          {canManage ? (
            <Card>
              <SectionHeader title="Details" />
              <LeadForm
                leadId={lead.id}
                clients={clients}
                defaults={{
                  name: lead.name,
                  phone: lead.phone ?? "",
                  email: lead.email ?? "",
                  company: lead.company ?? "",
                  source: lead.source,
                  currency: lead.currency ?? "BDT",
                  value: lead.valueMinor ? fromMinor(BigInt(lead.valueMinor)) : "",
                  nextFollowUpAt: toLocalInput(lead.nextFollowUpAt),
                  notes: lead.notes ?? "",
                  clientId: lead.clientId ?? "",
                }}
              />
            </Card>
          ) : (
            <Card>
              <SectionHeader title="Details" />
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt className="text-[color:var(--color-muted-foreground)]">Phone</dt>
                <dd>{lead.phone ?? "—"}</dd>
                <dt className="text-[color:var(--color-muted-foreground)]">Company</dt>
                <dd>{lead.company ?? "—"}</dd>
                <dt className="text-[color:var(--color-muted-foreground)]">Value</dt>
                <dd>{lead.value ?? "—"}</dd>
                <dt className="text-[color:var(--color-muted-foreground)]">Follow-up</dt>
                <dd>{lead.nextFollowUpAt ? when(lead.nextFollowUpAt) : "—"}</dd>
              </dl>
              {lead.notes ? <p className="mt-3 whitespace-pre-wrap text-sm">{lead.notes}</p> : null}
            </Card>
          )}
        </div>
        <div className="space-y-6">
          <Card>
            <SectionHeader title="Notes and history" />
            {canManage ? (
              <div className="mb-4">
                <LeadNoteForm leadId={lead.id} />
              </div>
            ) : null}
            <ol className="space-y-3 text-sm">
              {lead.events.map((e) => (
                <li key={e.id} className="border-l-2 border-[var(--color-border)] pl-3">
                  <p className={e.kind === "NOTE" ? "whitespace-pre-wrap" : ""}>{describe(e)}</p>
                  <p className="text-xs text-[color:var(--color-muted-foreground)]">
                    {when(e.createdAt)} · {e.actorUsername}
                  </p>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}
