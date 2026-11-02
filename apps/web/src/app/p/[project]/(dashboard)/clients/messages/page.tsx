import { Clock, MailCheck, ShieldCheck, UserX } from "lucide-react";
import { MESSAGE_BATCH_APPROVAL_HOURS, MESSAGE_BATCH_STATUS_LABELS, type MessageBatchStatus } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { hasPermission } from "@/server/permissions";
import { emailChannelReady, listClientMessages } from "@/server/clientMessages";
import Link from "@/components/ProjectLink";
import { Alert, Badge, EmptyState, HelpButton, HelpSection } from "@/components/ui";
import { ChipTabs, KpiCard, mutedText, surface, type Chip } from "../ModuleKit";
import { MessageHistory } from "./MessageHistory";
import { BatchDecision } from "./BatchParts";

export const metadata = { title: "Client messages" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const VIEWS = ["pending", "queued", "closed", "all"] as const;
/** The moment this page is drawn: whether a batch is past its approval window is read against it. */
const pageTime = () => Date.now();

/**
 * Bulk email to clients (CLIENT_CRM_V7.md §7). A batch is prepared by one person (All Clients or the Billing List →
 * select → Bulk email), APPROVED by a different person within 24 hours, then queued into the project's email
 * outbox and sent at the project's own pace. Each recipient's state is the outbox's: accepted by the mail server,
 * failed, or unknown — never "delivered", which email cannot prove.
 */
export default async function ClientMessagesPage({ searchParams }: { searchParams: SearchParams }) {
  const { session } = await pageAccess("clients.view", "clients.send_messages");
  const raw = await searchParams;
  const view = (VIEWS as readonly string[]).includes(String(raw.view ?? "")) ? (raw.view as (typeof VIEWS)[number]) : "pending";
  const batchId = typeof raw.batch === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(raw.batch) ? raw.batch : null;
  const statusFilter = view === "pending" ? ["PENDING_APPROVAL"] : view === "queued" ? ["QUEUED"] : view === "closed" ? ["REJECTED", "EXPIRED", "CANCELLED"] : null;
  const [batches, counts, canApprove, canSend, ready, selected] = await Promise.all([
    prisma.clientMessageBatch.findMany({ where: statusFilter ? { status: { in: statusFilter } } : {}, orderBy: { submittedAt: "desc" }, take: 100 }),
    prisma.clientMessageBatch.groupBy({ by: ["status"], _count: { _all: true } }),
    hasPermission(session, "clients.approve_messages"),
    hasPermission(session, "clients.send_messages"),
    emailChannelReady(),
    batchId ? prisma.clientMessageBatch.findFirst({ where: { id: batchId } }) : null,
  ]);
  const recipients = selected ? await listClientMessages({ batchId: selected.id }, 500) : [];
  const count = (s: string[]) => counts.filter((c) => s.includes(c.status)).reduce((n, c) => n + c._count._all, 0);
  const now = pageTime();
  const expired = (b: { status: string; submittedAt: Date }) => b.status === "PENDING_APPROVAL" && now - b.submittedAt.getTime() > MESSAGE_BATCH_APPROVAL_HOURS * 3_600_000;
  const chips: Chip[] = [
    { key: "pending", label: "Waiting for approval", count: count(["PENDING_APPROVAL"]), href: "/clients/messages", active: view === "pending", tone: "warning" },
    { key: "queued", label: "Approved", count: count(["QUEUED"]), href: "/clients/messages?view=queued", active: view === "queued" },
    { key: "closed", label: "Rejected / expired / cancelled", count: count(["REJECTED", "EXPIRED", "CANCELLED"]), href: "/clients/messages?view=closed", active: view === "closed" },
    { key: "all", label: "All", count: count(["PENDING_APPROVAL", "QUEUED", "REJECTED", "EXPIRED", "CANCELLED"]), href: "/clients/messages?view=all", active: view === "all" },
  ];
  const queuedStates = recipients.reduce<Record<string, number>>((acc, m) => ({ ...acc, [m.state]: (acc[m.state] ?? 0) + 1 }), {});

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] sm:text-[28px]">Bulk email</h1>
          <p className={`mt-1 text-sm ${mutedText}`}>Emails to several clients at once — prepared by one person, approved by another, sent at the project&apos;s email pace.</p>
        </div>
        <HelpButton moduleTitle="Bulk email">
          <HelpSection title="How a bulk email goes out">
            <p>Select clients on All Clients (or invoices on the Billing List), choose Bulk email and a template. Each recipient is filled in and checked. Someone ELSE with the approve permission must approve within {MESSAGE_BATCH_APPROVAL_HOURS} hours; only then is anything queued.</p>
          </HelpSection>
          <HelpSection title="Who is skipped">
            <p>No email address, opted out, email consent not recorded, archived, or an address already in the batch. Consent is checked again at approval and again when each email is sent.</p>
          </HelpSection>
          <HelpSection title="WhatsApp">
            <p>Bulk messages go by email only. WhatsApp messages are prepared one client at a time with Message client, and sent by a person.</p>
          </HelpSection>
        </HelpButton>
      </div>
      {ready.ready ? null : <Alert tone="info">{ready.reason} Batches can be prepared, but cannot be approved until email is connected.</Alert>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiCard icon={Clock} accent="amber" label="Waiting for approval" value={String(count(["PENDING_APPROVAL"]))} hint={`Expires after ${MESSAGE_BATCH_APPROVAL_HOURS} hours`} href="/clients/messages" />
        <KpiCard icon={MailCheck} accent="green" label="Approved batches" value={String(count(["QUEUED"]))} href="/clients/messages?view=queued" />
        <KpiCard icon={UserX} accent="slate" label="Closed" value={String(count(["REJECTED", "EXPIRED", "CANCELLED"]))} href="/clients/messages?view=closed" />
      </div>
      <ChipTabs label="Batch views" chips={chips} />

      {batches.length === 0 ? (
        <EmptyState>{view === "pending" ? "Nothing waiting for approval." : "No batch here."}</EmptyState>
      ) : (
        <ul className="space-y-3">
          {batches.map((b) => {
            const isExpired = expired(b);
            const status = (isExpired ? "EXPIRED" : b.status) as MessageBatchStatus;
            return (
              <li key={b.id} className={`${surface} p-4`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/clients/messages?${view === "pending" ? "" : `view=${view}&`}batch=${b.id}`} className="font-semibold hover:underline">
                      {b.templateName} <span className={`font-normal ${mutedText}`}>v{b.templateVersion}</span>
                    </Link>
                    <p className={`text-xs ${mutedText}`}>
                      Prepared by {b.submittedByName ?? "—"} · {b.submittedAt.toLocaleString("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" })}
                      {b.decidedByName ? ` · ${b.status === "QUEUED" ? "approved" : "closed"} by ${b.decidedByName}` : ""}
                    </p>
                    <p className="mt-1 text-sm">
                      {b.eligibleCount} to send · {b.skippedCount} skipped · {b.recipientCount} selected
                    </p>
                    {b.decisionNote ? <p className={`mt-1 text-xs ${mutedText}`}>Note: {b.decisionNote}</p> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge color={status === "QUEUED" ? "green" : status === "PENDING_APPROVAL" ? "yellow" : "gray"}>{MESSAGE_BATCH_STATUS_LABELS[status]}</Badge>
                    {b.status === "PENDING_APPROVAL" && !isExpired ? (
                      <BatchDecision batchId={b.id} isSubmitter={b.submittedById === session.userId} canApprove={canApprove && b.submittedById !== session.userId && ready.ready} canCancel={canSend && b.submittedById === session.userId} canReject={canApprove && b.submittedById !== session.userId} />
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {selected ? (
        <section className={`${surface} p-5`}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold">
              <ShieldCheck className={`size-4 ${mutedText}`} aria-hidden /> Recipients of “{selected.templateName}”
            </h2>
            <p className={`text-xs ${mutedText}`}>
              {Object.entries(queuedStates)
                .map(([k, n]) => `${n} ${k.toLowerCase().replace(/_/g, " ")}`)
                .join(" · ")}
            </p>
          </div>
          <MessageHistory messages={recipients} empty="No recipients." />
        </section>
      ) : null}
    </div>
  );
}
