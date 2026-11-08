import { CONVERSATION_PRIORITY_LABEL, isTicketView, TICKET_STATUS_LABEL, TICKET_STATUSES, TICKET_VIEW_LABEL, TICKET_VIEWS, type TicketView } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { prisma } from "@/server/db";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { mentionablePeople } from "@/server/inboxWorkspace";
import { listTickets, loadTicketConfig, readTicketFilters } from "@/server/tickets";
import { AutoRefresh } from "@/components/AutoRefresh";
import Link from "@/components/ProjectLink";
import { Badge, Button, Card, EmptyState, Field, FilterBar, HelpButton, HelpSection, Input, PageHeader, Select } from "@/components/ui";
import { TICKET_CLOCK_CLASS, TICKET_PRIORITY_COLOR, TICKET_STATUS_COLOR } from "@/components/tickets/ticketDisplay";
import { NewTicketButton } from "./NewTicketButton";

export const metadata = { title: "Tickets" };

const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;

const EMPTY: Record<TicketView, string> = {
  MINE: "Nothing is waiting on you. Open a ticket here, or from any conversation's side panel.",
  UNASSIGNED: "Every open ticket has somebody on it.",
  ACTIVE: "No open tickets.",
  WAITING: "No ticket is waiting on a customer.",
  OVERDUE: "Nothing is overdue.",
  RESOLVED: "No ticket has been resolved yet.",
};

/**
 * Support tickets (TICKETS.md): numbered cases with an owner and a due time. Internal work only: nothing on this page
 * sends anything to a customer.
 */
export default async function TicketsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requireAccess("messages.view", "TICKETS");
  const params = await searchParams;
  const view: TicketView = isTicketView(params.view) ? params.view : "MINE";
  const filters = readTicketFilters(params);
  const disabled = await activeDisabledFeatures();
  const now = new Date();

  const [list, people, teams, config, canWhatsApp, canChannels] = await Promise.all([
    listTickets(session, view, filters, now),
    mentionablePeople(session),
    prisma.team.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    loadTicketConfig(),
    disabled.has("WHATSAPP_CHAT") ? false : hasPermission(session, "messages.reply"),
    disabled.has("OMNICHANNEL") ? false : hasPermission(session, "conversations.reply"),
  ]);

  const query: Record<string, string> = {};
  for (const key of ["view", "assignee", "team", "priority", "status", "q"] as const) if (params[key]) query[key] = params[key]!;
  const href = (overrides: Record<string, string | null>) => {
    const qs = new URLSearchParams(query);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null) qs.delete(k);
      else qs.set(k, v);
    }
    const s = qs.toString();
    return `/tickets${s ? `?${s}` : ""}`;
  };
  const filtering = Boolean(filters.assignee || filters.team || filters.priority || filters.status || filters.q);

  return (
    <div className="min-w-0">
      {/* Overdue moves as time passes and colleagues close things: follow it without a reload. */}
      <AutoRefresh intervalMs={30000} />
      <PageHeader
        title="Tickets"
        description="Every problem as a numbered case, with an owner and a due time. Internal: nothing here is sent to a customer."
        actions={
          <>
            <HelpButton moduleTitle="Tickets">
              <HelpSection title="Tickets and conversations">
                <p>
                  A conversation is what was said. A ticket is a problem being worked on, so it can outlast many messages, and one
                  conversation can hold several. Open one from the Tickets tab beside any conversation.
                </p>
              </HelpSection>
              <HelpSection title="Due times">
                <p>
                  Each priority has a target, set in Settings → Tickets. While a ticket waits on the customer its clock stops, and the
                  time waited is added back when work resumes. Reopening starts a new target.
                </p>
              </HelpSection>
              <HelpSection title="Who can change them">
                <p>
                  Anyone who can read conversations sees this page. Changing a ticket needs the right to reply to the conversation it
                  is about; one about no conversation needs either right. Every change is kept in its history.
                </p>
              </HelpSection>
            </HelpButton>
            {canWhatsApp || canChannels ? <NewTicketButton options={{ people, teams, categories: config.categories, viewerId: session.userId }} /> : null}
          </>
        }
      />

      <nav aria-label="Ticket lists" className="-mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {TICKET_VIEWS.map((v) => {
          const active = v === view;
          const urgent = v === "OVERDUE" && list.counts.OVERDUE > 0;
          return (
            <Link
              key={v}
              href={href({ view: v === "MINE" ? null : v })}
              aria-current={active ? "page" : undefined}
              className={`shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium ${
                active
                  ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]"
                  : urgent
                    ? "bg-[var(--color-danger-bg)] text-[color:var(--color-danger-fg)]"
                    : "bg-[var(--color-neutral-bg)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
              }`}
            >
              {TICKET_VIEW_LABEL[v]}
              <span className="tabular ml-1 opacity-80">{list.counts[v].toLocaleString("en-US")}</span>
            </Link>
          );
        })}
      </nav>

      <form method="get">
        {view !== "MINE" ? <input type="hidden" name="view" value={view} /> : null}
        <FilterBar>
          <Field label="Search">
            <Input name="q" defaultValue={filters.q} placeholder="Number or subject" />
          </Field>
          {/* On a phone the lists above and search do the work: four more selects would push the tickets off the screen. */}
          <div className="hidden md:contents">
          <Field label="Person">
            <Select name="assignee" defaultValue={filters.assignee ?? ""}>
              <option value="">Anyone</option>
              <option value="me">Me</option>
              <option value="none">Nobody yet</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Team">
            <Select name="team" defaultValue={filters.team ?? ""}>
              <option value="">Any Team</option>
              <option value="none">No Team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select name="priority" defaultValue={filters.priority ?? ""}>
              <option value="">Any priority</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {CONVERSATION_PRIORITY_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select name="status" defaultValue={filters.status ?? ""}>
              <option value="">Any status</option>
              {TICKET_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TICKET_STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
          </div>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          {filtering ? (
            <Link href={href({ assignee: null, team: null, priority: null, status: null, q: null })} className="self-center text-[13px] text-[color:var(--color-accent)] hover:underline">
              Clear filters
            </Link>
          ) : null}
        </FilterBar>
      </form>

      {list.rows.length === 0 ? (
        <Card>
          <EmptyState>{filtering ? "No ticket matches these filters." : EMPTY[view]}</EmptyState>
        </Card>
      ) : (
        <ul className="space-y-2">
          {list.rows.map((t) => (
            <li key={t.id}>
              <Card className="relative p-3.5 transition-colors hover:border-[var(--color-border-strong)] sm:p-4">
                <div className="grid gap-x-4 gap-y-2 md:grid-cols-[minmax(0,1fr)_11rem_10rem] md:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="tabular text-[12.5px] font-medium text-[color:var(--color-muted-foreground)]">{t.label}</span>
                      <Badge color={TICKET_STATUS_COLOR[t.status]}>{TICKET_STATUS_LABEL[t.status]}</Badge>
                      {t.priority === "HIGH" || t.priority === "URGENT" ? <Badge color={TICKET_PRIORITY_COLOR[t.priority]}>{CONVERSATION_PRIORITY_LABEL[t.priority]}</Badge> : null}
                      {t.category ? <span className="text-[12px] text-[color:var(--color-muted-foreground)]">{t.category}</span> : null}
                    </div>
                    <Link href={`/tickets/${t.id}`} className="mt-1 block truncate text-[14.5px] font-semibold text-[color:var(--color-foreground)] after:absolute after:inset-0 hover:underline">
                      {t.subject}
                    </Link>
                    {t.client || t.conversation ? (
                      <p className="mt-0.5 truncate text-[12.5px] text-[color:var(--color-muted-foreground)]">
                        {[t.client?.name, t.conversation?.label].filter(Boolean).join(" · ")}
                      </p>
                    ) : null}
                  </div>
                  <div className="min-w-0 text-[13px]">
                    <span className="block truncate text-[color:var(--color-foreground)]">{t.assignedUserName ?? "Nobody yet"}</span>
                    {t.assignedTeamName ? <span className="block truncate text-[12px] text-[color:var(--color-muted-foreground)]">{t.assignedTeamName}</span> : null}
                  </div>
                  <div className={`text-[13px] md:text-right ${TICKET_CLOCK_CLASS[t.clock.tone]}`}>{t.clock.text}</div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {list.truncated ? <p className="mt-3 text-[13px] text-[color:var(--color-muted-foreground)]">Showing the first 200. Narrow the list with the filters to see the rest.</p> : null}
    </div>
  );
}
