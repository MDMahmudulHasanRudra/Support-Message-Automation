import { Card } from "@/components/ui";
import { ChartCard, StackedBar } from "@/components/charts";
import {
  REPLY_CATEGORIES_OF_REPLIES,
  REPLY_CATEGORY_LABELS,
  reliabilityLines,
  responseLines,
  type ReliabilityLine,
  type ReplyCategoryOfReply,
  type ReportingReliability,
  type ResponseMetrics,
} from "@support-automation/shared";

/** Identity slots, not state colours: no category is good or bad by itself (CLAUDE.md, charts). */
const CATEGORY_COLORS: Record<ReplyCategoryOfReply, string> = {
  HUMAN_TEAM_MEMBER: "var(--chart-1)",
  AUTOMATED_AI: "var(--chart-2)",
  AUTOMATED_RULE: "var(--chart-3)",
  OTHER_BUSINESS_REPLY: "var(--chart-4)",
  UNKNOWN_OR_UNATTRIBUTED: "var(--chart-5)",
};

const count = (value: number | string) => (typeof value === "number" ? value.toLocaleString("en-US") : value);

/** Lines grouped under their section heading — the same lines the Excel "Data quality" sheet writes. */
function LineGroups({ lines }: { lines: ReliabilityLine[] }) {
  const sections = [...new Set(lines.map((line) => line.section))];
  return (
    <div className="space-y-4">
      {sections.map((section) => (
        <div key={section}>
          <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">{section}</h3>
          <dl className="divide-y divide-[var(--color-border)]">
            {lines
              .filter((line) => line.section === section)
              .map((line) => (
                <div key={line.label} className="flex items-start justify-between gap-3 py-1.5 text-[13px]">
                  <dt className="min-w-0">
                    <span className="text-[color:var(--color-foreground)]">{line.label}</span>
                    {line.note ? <span className="block text-[12px] text-[color:var(--color-muted-foreground)]">{line.note}</span> : null}
                  </dt>
                  <dd className="tabular m-0 shrink-0 font-medium text-[color:var(--color-foreground)]">{count(line.value)}</dd>
                </div>
              ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

/**
 * Who answered, and how far the period's figures can be trusted (PHASE2.md Stage 7). Sits below the
 * report and changes none of its figures: the waits above end at any reply, AI's included; the human
 * measure here is Human Response SLA's.
 */
export function ReliabilitySection({ response, reliability }: { response: ResponseMetrics; reliability: ReportingReliability }) {
  const answered = REPLY_CATEGORIES_OF_REPLIES.reduce((sum, c) => sum + response.firstReplyBy[c], 0) + response.firstReplyBy.UNCLASSIFIED;
  return (
    <section className="mt-5 grid grid-cols-1 gap-3.5 lg:grid-cols-2">
      <ChartCard
        title="How customers were answered"
        description="Who sent the reply that ended each wait, then three measures, each defined once. None of them changes a figure above."
      >
        <StackedBar
          segments={REPLY_CATEGORIES_OF_REPLIES.map((c) => ({ key: c, label: REPLY_CATEGORY_LABELS[c], value: response.firstReplyBy[c], color: CATEGORY_COLORS[c] }))}
          total={answered}
          ariaLabel="Answered customer waits, by who sent the first reply"
          emptyMessage="No customer wait was answered in this period."
        />
        <div className="mt-5">
          <LineGroups lines={responseLines(response).filter((line) => line.section !== "First reply came from")} />
        </div>
      </ChartCard>
      <Card className="p-5">
        <h2 className="text-[15px] font-semibold text-[color:var(--color-foreground)]">Reporting reliability</h2>
        <p className="mb-4 mt-1 text-[13px] text-[color:var(--color-muted-foreground)]">
          What this period&apos;s figures were built from, as counts. No accuracy score is given: any weighting of these
          would be a judgement, not a measurement.
        </p>
        <LineGroups lines={reliabilityLines(reliability)} />
      </Card>
    </section>
  );
}
