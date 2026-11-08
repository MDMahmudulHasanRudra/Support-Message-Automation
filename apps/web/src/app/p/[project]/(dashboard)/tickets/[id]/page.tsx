import { notFound } from "next/navigation";
import { ArrowLeft, Lock, MessageCircle, UserRound } from "lucide-react";
import { TICKET_STATUS_LABEL } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { prisma } from "@/server/db";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { mentionablePeople } from "@/server/inboxWorkspace";
import { loadTicketConfig, loadTicketDetail, type TicketEventView } from "@/server/tickets";
import Link from "@/components/ProjectLink";
import { Badge, Card } from "@/components/ui";
import { TICKET_CLOCK_CLASS, TICKET_STATUS_COLOR } from "@/components/tickets/ticketDisplay";
import { TicketDescription, TicketNoteForm, TicketProperties, TicketStatusActions } from "./TicketControls";

export const metadata = { title: "Ticket" };

const when = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));

function eventText(e: TicketEventView): string {
  switch (e.kind) {
    case "CREATED":
      return "opened this ticket";
    case "STATUS":
      return `moved it from ${e.fromValue} to ${e.toValue}`;
    case "ASSIGNED":
      return `gave it to ${e.toValue} (was ${e.fromValue})`;
    case "TEAM":
      return `moved it to ${e.toValue} (was ${e.fromValue})`;
    case "PRIORITY":
      return `changed the priority from ${e.fromValue} to ${e.toValue}`;
    case "CATEGORY":
      return `changed the category to ${e.toValue ?? "none"}`;
    case "DUE":
      return `changed the due time to ${e.toValue}`;
    case "EDITED":
      return "edited the subject or details";
    default:
      return "";
  }
}

/** One ticket (TICKETS.md): what it is, where it stands, who has it, and everything that happened. */
export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAccess("messages.view", "TICKETS");
  const { id } = await params;
  const now = new Date();
  const ticket = await loadTicketDetail(session, id, now);
  if (!ticket) notFound();

  const disabled = await activeDisabledFeatures();
  const canWhatsApp = !disabled.has("WHATSAPP_CHAT") && (await hasPermission(session, "messages.reply"));
  const canChannels = !disabled.has("OMNICHANNEL") && (await hasPermission(session, "conversations.reply"));
  const canWrite = ticket.linkKind === "whatsapp" ? canWhatsApp : ticket.linkKind === "channel" ? canChannels : canWhatsApp || canChannels;
  const [people, teams, config] = await Promise.all([
    mentionablePeople(session),
    prisma.team.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    loadTicketConfig(),
  ]);

  return (
    <div className="min-w-0">
      <Link href="/tickets" className="link mb-3 inline-flex items-center gap-1 text-[13px]">
        <ArrowLeft className="size-3.5" aria-hidden />
        All tickets
      </Link>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-80">
          <div className="flex flex-wrap items-center gap-2">
            <span className="tabular text-[13px] font-medium text-[color:var(--color-muted-foreground)]">{ticket.label}</span>
            <Badge color={TICKET_STATUS_COLOR[ticket.status]}>{TICKET_STATUS_LABEL[ticket.status]}</Badge>
            <span className={`text-[13px] ${TICKET_CLOCK_CLASS[ticket.clock.tone]}`}>{ticket.clock.text}</span>
          </div>
          <h1 className="mt-1.5 text-2xl font-semibold tracking-[-0.02em] [overflow-wrap:anywhere] sm:text-[26px]">{ticket.subject}</h1>
        </div>
        {canWrite ? <TicketStatusActions id={ticket.id} status={ticket.status} /> : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          <Card className="p-4 sm:p-5">
            <TicketDescription id={ticket.id} updatedAt={ticket.updatedAt} subject={ticket.subject} description={ticket.description} canEdit={canWrite && ticket.status !== "RESOLVED" && ticket.status !== "CLOSED"} />
          </Card>

          <Card className="p-4 sm:p-5">
            <h2 className="flex items-center gap-1.5 text-[14px] font-semibold">
              History and notes
              <span className="inline-flex items-center gap-1 text-[12px] font-normal text-[color:var(--color-muted-foreground)]">
                <Lock className="size-3" aria-hidden />
                the customer never sees these
              </span>
            </h2>
            {canWrite ? <TicketNoteForm id={ticket.id} /> : null}
            <ol className="mt-4 space-y-3">
              {ticket.events.map((e) =>
                e.kind === "NOTE" ? (
                  <li key={e.id} className="rounded-[var(--radius-md)] border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)]/50 p-3">
                    <p className="text-[12px] text-[color:var(--color-muted-foreground)]">
                      <span className="font-medium text-[color:var(--color-foreground)]">{e.actorName ?? "Former user"}</span> · {when(e.createdAt)}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-[13.5px] [overflow-wrap:anywhere]" dir="auto">
                      {e.body}
                    </p>
                  </li>
                ) : (
                  <li key={e.id} className="text-[13px] text-[color:var(--color-muted-foreground)]">
                    <span className="font-medium text-[color:var(--color-foreground)]">{e.actorName ?? "Former user"}</span> {eventText(e)} · {when(e.createdAt)}
                  </li>
                ),
              )}
            </ol>
          </Card>
        </div>

        <aside className="min-w-0 space-y-4">
          <Card className="p-4">
            <TicketProperties
              id={ticket.id}
              updatedAt={ticket.updatedAt}
              canEdit={canWrite && ticket.status !== "RESOLVED" && ticket.status !== "CLOSED"}
              values={{ assignedUserId: ticket.assignedUserId ?? "", assignedTeamId: ticket.assignedTeamId ?? "", priority: ticket.priority, category: ticket.category ?? "", due: ticket.dueInput }}
              people={people}
              teams={teams}
              categories={config.categories}
            />
          </Card>
          <Card className="space-y-2.5 p-4 text-[13px]">
            {ticket.conversation ? (
              <Link href={ticket.conversation.href} className="link flex items-center gap-2">
                <MessageCircle className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{ticket.conversation.label}</span>
              </Link>
            ) : (
              <p className="flex items-center gap-2 text-[color:var(--color-muted-foreground)]">
                <MessageCircle className="size-4 shrink-0" aria-hidden />
                No conversation linked
              </p>
            )}
            {ticket.client ? (
              <Link href={`/clients/${ticket.client.id}`} className="link flex items-center gap-2">
                <UserRound className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">
                  {ticket.client.name} · {ticket.client.code}
                </span>
              </Link>
            ) : (
              <p className="flex items-center gap-2 text-[color:var(--color-muted-foreground)]">
                <UserRound className="size-4 shrink-0" aria-hidden />
                No client linked
              </p>
            )}
            <p className="border-t border-[var(--color-border)] pt-2.5 text-[12px] text-[color:var(--color-muted-foreground)]">
              Opened {when(ticket.createdAt)}
              {ticket.createdByName ? ` by ${ticket.createdByName}` : ""}
            </p>
          </Card>
        </aside>
      </div>
    </div>
  );
}
