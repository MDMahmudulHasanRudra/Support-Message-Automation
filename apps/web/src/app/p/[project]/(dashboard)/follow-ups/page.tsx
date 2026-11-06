import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { prisma } from "@/server/db";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { mentionablePeople } from "@/server/inboxWorkspace";
import { listFollowUps, readFollowUpFilters } from "@/server/followUps";
import { AutoRefresh } from "@/components/AutoRefresh";
import Link from "@/components/ProjectLink";
import { Button, Field, FilterBar, HelpButton, HelpSection, PageHeader, Select } from "@/components/ui";
import { CONVERSATION_PRIORITIES, CONVERSATION_PRIORITY_LABEL, FOLLOW_UP_VIEW_LABEL, FOLLOW_UP_VIEWS, isFollowUpView, type FollowUpView } from "@support-automation/shared";
import { FollowUpBoard, NewFollowUpButton } from "./FollowUpBoard";

/**
 * Follow-ups (FOLLOW_UPS.md, feature FOLLOW_UPS): call-backs, technician visits and promised replies.
 * Mine / Team are who; Overdue / Due today / Upcoming are when (Dhaka days); Done / Discarded are closed.
 * Internal work only — nothing on this page sends anything to a customer.
 */
export default async function FollowUpsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requireAccess("messages.view", "FOLLOW_UPS");
  const params = await searchParams;
  const view: FollowUpView = isFollowUpView(params.view) ? params.view : "MINE";
  const filters = readFollowUpFilters(params);
  const disabled = await activeDisabledFeatures();
  const now = new Date();

  const [list, people, teams, canWhatsApp, canChannels] = await Promise.all([
    listFollowUps(session, view, filters, now),
    mentionablePeople(session),
    prisma.team.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    disabled.has("WHATSAPP_CHAT") ? false : hasPermission(session, "messages.reply"),
    disabled.has("OMNICHANNEL") ? false : hasPermission(session, "conversations.reply"),
  ]);

  const query: Record<string, string> = {};
  for (const key of ["view", "assignee", "team", "priority"] as const) if (params[key]) query[key] = params[key]!;
  const href = (overrides: Record<string, string | null>) => {
    const qs = new URLSearchParams(query);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null) qs.delete(k);
      else qs.set(k, v);
    }
    const s = qs.toString();
    return `/follow-ups${s ? `?${s}` : ""}`;
  };
  const canCreate = canWhatsApp || canChannels;

  return (
    <div className="min-w-0">
      {/* Overdue moves as time passes and colleagues close things: follow it without a reload. */}
      <AutoRefresh intervalMs={30000} />
      <PageHeader
        title="Follow-ups"
        description="Call-backs, technician visits and promised replies — with a due time and an owner. Internal only: nothing here is sent to a customer."
        actions={
          <>
            <HelpButton moduleTitle="Follow-ups">
              <HelpSection title="The lists">
                <p>
                  <strong>Mine</strong> is everything open that is yours: given to you, given to your Team with no person yet, or written
                  by you for nobody in particular. <strong>Team</strong> is everything open in this project. <strong>Overdue</strong>,{" "}
                  <strong>Due today</strong> and <strong>Upcoming</strong> are everybody&rsquo;s open follow-ups by due time — narrow
                  them with the filters. Days are Dhaka days: &ldquo;due today&rdquo; ends at midnight Dhaka time.
                </p>
              </HelpSection>
              <HelpSection title="Reminders">
                <p>
                  The clock in the top bar counts your overdue and due-today follow-ups. Nothing is sent by WhatsApp, email or any other
                  channel — to the team or to the customer.
                </p>
              </HelpSection>
              <HelpSection title="Who can change them">
                <p>
                  Anyone who can read conversations sees this page. Changing a follow-up needs the right to reply to the conversation it
                  is about (WhatsApp Chat or the other channels); one about no conversation needs either. Every change is kept in its
                  history with who made it.
                </p>
              </HelpSection>
            </HelpButton>
            {canCreate ? <NewFollowUpButton people={people} teams={teams} viewerId={session.userId} /> : null}
          </>
        }
      />

      <nav aria-label="Follow-up lists" className="-mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {FOLLOW_UP_VIEWS.map((v) => {
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
              {FOLLOW_UP_VIEW_LABEL[v]}
              <span className="tabular ml-1 opacity-80">{list.counts[v].toLocaleString("en-US")}</span>
            </Link>
          );
        })}
      </nav>

      <form method="get">
        {view !== "MINE" ? <input type="hidden" name="view" value={view} /> : null}
        <FilterBar>
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
              {CONVERSATION_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {CONVERSATION_PRIORITY_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          {filters.assignee || filters.team || filters.priority ? (
            <Link href={href({ assignee: null, team: null, priority: null })} className="self-center text-[13px] text-[color:var(--color-accent)] hover:underline">
              Clear filters
            </Link>
          ) : null}
        </FilterBar>
      </form>

      <FollowUpBoard
        rows={list.rows}
        view={view}
        nowIso={now.toISOString()}
        people={people}
        teams={teams}
        viewerId={session.userId}
        canWhatsApp={canWhatsApp}
        canChannels={canChannels}
      />
      {list.truncated ? (
        <p className="mt-3 text-[13px] text-[color:var(--color-muted-foreground)]">Showing the first 200. Narrow the list with the filters to see the rest.</p>
      ) : null}
    </div>
  );
}
