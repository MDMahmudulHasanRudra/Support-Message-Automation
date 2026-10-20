import { REPLY_TIER_LABELS, UNRESOLVED_REASON_LABELS, type ReplyAttributionResult } from "@support-automation/shared";
import { ChartCard, StackedBar } from "@/components/charts";
import { formatDurationShort } from "@/lib/duration";
import { StatTile } from "@/components/ui";

const count = (n: number) => n.toLocaleString("en-US");

/**
 * "Customer-specific replies (evidence-based)", BESIDE the group figures and never changing one. In a group
 * the wait above is the group's ("somebody replied"); this counts which CUSTOMER each reply answered, and only
 * where the conversation itself says so: the reply quotes the customer's message, @-mentions the customer, or
 * the customer was the only one waiting. A reply nothing links is shown as such — it is not evidence that the
 * customer was ignored. Counts only; no message text and no accuracy score.
 */
export function CustomerSpecificReplies({ attribution }: { attribution: ReplyAttributionResult }) {
  const { asks, replies, customerSpecificWait } = attribution;
  const linked = asks.answeredTier1 + asks.answeredTier2Mention + asks.answeredTier2Sequence;
  const reasons = Object.entries(replies.unresolvedReasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return (
    <section className="mt-5">
      <h2 className="text-[15px] font-semibold text-[color:var(--color-foreground)]">Customer-specific replies (evidence-based)</h2>
      <p className="mb-3 mt-1 text-[13px] text-[color:var(--color-muted-foreground)]">
        Which customer each reply answered, from what the conversation shows. It sits beside the group waits above and changes none of them.
      </p>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Customer requests" value={count(asks.total)} hint="a customer's run of lines in a group, started in the period" />
        <StatTile
          label="Answered, linked to the customer"
          value={count(linked)}
          hint={`${count(asks.answeredTier1)} quoted · ${count(asks.answeredTier2Mention)} mentioned · ${count(asks.answeredTier2Sequence)} only one waiting`}
        />
        <StatTile
          label="No linked reply"
          value={count(asks.unanswered + asks.pending)}
          hint={`${count(asks.unanswered)} past their time · ${count(asks.pending)} still inside it. No reply could be linked to this customer by quote, mention or sequence.`}
        />
        <StatTile
          label="Median customer-specific wait"
          value={customerSpecificWait.medianSeconds === null ? "—" : formatDurationShort(customerSpecificWait.medianSeconds)}
          hint={`${count(customerSpecificWait.samples)} linked ${customerSpecificWait.samples === 1 ? "request" : "requests"}${asks.noCustomerId > 0 ? ` · ${count(asks.noCustomerId)} line(s) with no sender id left out` : ""}`}
        />
      </div>
      <ChartCard title="How replies were linked" description="Every reply in these groups, by the evidence that tied it to a customer. Identity colours, not good or bad.">
        <StackedBar
          segments={[
            { key: "quote", label: REPLY_TIER_LABELS.TIER1_QUOTE, value: replies.byTier.TIER1_QUOTE, color: "var(--chart-1)" },
            { key: "mention", label: REPLY_TIER_LABELS.TIER2_MENTION, value: replies.byTier.TIER2_MENTION, color: "var(--chart-2)" },
            { key: "sequence", label: REPLY_TIER_LABELS.TIER2_SEQUENCE, value: replies.byTier.TIER2_SEQUENCE, color: "var(--chart-3)" },
            { key: "unresolved", label: REPLY_TIER_LABELS.TIER4_UNRESOLVED, value: replies.byTier.TIER4_UNRESOLVED, color: "var(--chart-4)" },
          ]}
          total={replies.total}
          ariaLabel="Replies, by how they were linked to a customer"
          emptyMessage="No reply in these groups in this period."
        />
        {reasons.length > 0 ? (
          <dl className="mt-4 divide-y divide-[var(--color-border)]">
            {reasons.map(([reason, n]) => (
              <div key={reason} className="flex items-center justify-between gap-3 py-1.5 text-[13px]">
                <dt className="text-[color:var(--color-muted-foreground)]">Could not be linked: {UNRESOLVED_REASON_LABELS[reason] ?? reason}</dt>
                <dd className="tabular m-0 font-medium text-[color:var(--color-foreground)]">{count(n)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {replies.notAReply > 0 ? (
          <p className="mt-3 text-[12px] text-[color:var(--color-muted-foreground)]">{count(replies.notAReply)} broadcast message(s) were sent to everyone and answer nobody.</p>
        ) : null}
      </ChartCard>
    </section>
  );
}
