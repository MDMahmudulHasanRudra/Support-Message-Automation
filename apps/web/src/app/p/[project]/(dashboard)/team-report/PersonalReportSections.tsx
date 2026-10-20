import { Card, EmptyState, StatTile } from "@/components/ui";
import { ChartCard, ColumnChart } from "@/components/charts";
import { formatDurationShort } from "@/lib/duration";
import { bucketLabel } from "@/server/teamReport";
import type { PersonalReportData } from "@/server/personalReport";
import { buildPersonalBucketsTable, buildPersonalConversationsTable, buildPersonalMembersTable } from "@/server/teamReportTables";
import { ReportDataTable } from "./ReportDataTable";

const count = (n: number) => n.toLocaleString("en-US");
const median = (seconds: number | null) => (seconds === null ? "—" : formatDurationShort(seconds));

/**
 * The personal-chat half of the Team Report: tiles, one chart, and the three selectable tables. Counts
 * and conversation display names only; a conversation links to WhatsApp Chat only when the viewer may
 * open it (`linkToChat`). Shared by `scope=personal` (the whole page) and `scope=combined` (under its
 * own heading, after the group sections).
 */
export function PersonalReportSections({ data, query, linkToChat }: { data: PersonalReportData; query: string; linkToChat: boolean }) {
  const { result, filters, range, teamName } = data;
  const s = result.summary;
  const labelEvery = Math.max(1, Math.ceil(result.buckets.length / 10));
  const activity = result.buckets.map((b) => ({ label: bucketLabel(b.key, filters.granularity), value: b.customerMessages + b.businessReplies }));
  const scoped = Boolean(filters.memberId || teamName);
  const automated = s.automatedReplies.ai + s.automatedReplies.rule;

  if (s.conversations === 0 && s.excluded.ownNumber === 0 && s.excluded.internal === 0) {
    return <EmptyState>No personal chat had a message stored in {range.label}.</EmptyState>;
  }

  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Conversations"
          value={count(s.conversations)}
          hint={`${count(s.customerConversations)} with a customer message · ${count(s.newConversations)} first stored in this period${scoped ? " · only those they answered" : ""}`}
        />
        <StatTile label="Customer messages" value={count(s.customerMessages)} hint="from customers, personal chats" />
        <StatTile
          label="Verified employee replies"
          value={count(s.verifiedEmployeeReplies)}
          hint={`+ ${count(automated)} automated · ${count(s.businessPhoneReplies)} business phone · ${count(s.unlinkedOperatorReplies)} dashboard (unlinked)`}
        />
        <StatTile label="Waiting now" value={count(s.waitingConversations)} tone={s.waitingConversations > 0 ? "warning" : "neutral"} hint="latest message is the customer's" />
        <StatTile label="Missed" value={count(s.missed)} tone={s.missed > 0 ? "warning" : "neutral"} hint={`${count(s.unrecovered)} never answered`} />
        <StatTile label="Recall support" value={count(s.recalled)} tone="accent" hint="missed, then answered" />
        <StatTile label="Median first response" value={median(result.response.firstResponse.medianSeconds)} hint="any reply ends the wait" />
        <StatTile label="Median first human response" value={median(result.response.human.medianSeconds)} hint="only a person's reply, verified" />
      </div>

      {s.excluded.ownNumber + s.excluded.internal > 0 ? (
        <p className="mb-5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-4 py-2.5 text-[12px] leading-relaxed text-[color:var(--color-muted-foreground)]">
          Left out: {count(s.excluded.ownNumber)} chat(s) between our own numbers and {count(s.excluded.internal)} chat(s) with a team member — neither is a customer.
        </p>
      ) : null}

      <section className="mb-5">
        <ChartCard title="Personal chat activity" description={`Customer messages and replies per ${filters.granularity}, personal chats only.`}>
          <ColumnChart data={activity} ariaLabel="Personal chat messages over the period" labelEvery={labelEvery} />
        </ChartCard>
      </section>

      {!filters.memberId ? (
        <Card className="mb-5">
          <ReportDataTable
            table={buildPersonalMembersTable(data)}
            query={query}
            noun={{ singular: "team member", plural: "team members" }}
            title="Team members"
            description="Only dashboard replies by a login linked to a team member are credited to a person in personal chats. Select a name for that person's report."
          />
        </Card>
      ) : null}

      <Card className="mb-5">
        <ReportDataTable
          table={buildPersonalBucketsTable(data)}
          query={query}
          noun={filters.granularity === "day" ? { singular: "day", plural: "days" } : filters.granularity === "week" ? { singular: "week", plural: "weeks" } : { singular: "month", plural: "months" }}
          title={`By ${filters.granularity}`}
          description="The same figures, split over the period."
        />
      </Card>

      <Card>
        <ReportDataTable
          table={buildPersonalConversationsTable(data, { linkToChat })}
          query={query}
          noun={{ singular: "conversation", plural: "conversations" }}
          title={`Personal conversations (${count(result.conversations.length)})`}
          description="Every personal chat with a message in the period, busiest first. The same customer writing to two of our numbers is two conversations. A number WhatsApp hides is shown as a hidden number, never as a phone."
        />
      </Card>
    </>
  );
}
