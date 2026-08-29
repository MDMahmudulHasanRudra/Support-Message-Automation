/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import Link from "next/link";
import { prisma } from "@support-automation/db";
import type { Prisma } from "@prisma/client";
import { requireSession } from "@/server/auth";
import {
  Button,
  FilterBar,
  HelpButton,
  HelpSection,
  PageHeader,
  Pagination,
  Select,
  StatTile,
} from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { AiActivityTable, type AiActivityRow } from "./AiActivityTable";

export const metadata = { title: "AI Activity" };

const PAGE_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

interface AiActivitySearchParams {
  outcome?: string;
  groupId?: string;
  window?: string;
  page?: string;
}

const WINDOWS: Record<string, { label: string; days: number | null }> = {
  "24h": { label: "Last 24 hours", days: 1 },
  "7d": { label: "Last 7 days", days: 7 },
  "30d": { label: "Last 30 days", days: 30 },
  all: { label: "All time", days: null },
};

/**
 * Every decision the Hybrid AI Automation layer has made, and why.
 *
 * This is the page to sit on for the first week after switching AI automation on: it is the only
 * place that answers "what is the AI actually saying to my customers, and when does it give up?"
 * without opening messages one at a time. A handoff rate that stays high, or the same reason code
 * repeating, is the signal to adjust the confidence threshold or write a rule instead.
 */
export default async function AiActivityPage({
  searchParams,
}: {
  searchParams: Promise<AiActivitySearchParams>;
}) {
  await requireSession();
  const params = await searchParams;

  const windowKey = params.window && WINDOWS[params.window] ? params.window : "7d";
  const windowDays = WINDOWS[windowKey]!.days;
  const page = Math.max(1, Number(params.page ?? "1") || 1);

  // Read once and reused by both the list query and the stat queries below. Calling Date.now()
  // separately in each would give them slightly different window boundaries, so a row could sit
  // inside the list but outside the counts describing it.
  // eslint-disable-next-line react-hooks/purity -- server component runs fresh per request; not subject to render-purity rules
  const nowMs = Date.now();
  const windowStart = windowDays === null ? null : new Date(nowMs - windowDays * DAY_MS);

  const where: Prisma.AiFallbackDecisionWhereInput = {};
  if (params.outcome === "AI_REPLIED" || params.outcome === "HUMAN_FALLBACK") {
    where.outcome = params.outcome;
  }
  if (params.groupId) where.groupId = params.groupId;
  if (windowStart) where.createdAt = { gte: windowStart };

  // Counts are scoped to the time window but NOT to the outcome filter — otherwise filtering to
  // handoffs would show "100% handed off", which is true of the filter, not of the system.
  const statsWhere: Prisma.AiFallbackDecisionWhereInput = {
    ...(windowStart ? { createdAt: { gte: windowStart } } : {}),
    ...(params.groupId ? { groupId: params.groupId } : {}),
  };

  const [decisions, total, repliedCount, handoffCount, confidenceAgg, tokenAgg, groups] = await Promise.all([
    prisma.aiFallbackDecision.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        message: { select: { id: true, body: true, senderName: true, senderPhone: true } },
        group: { select: { id: true, name: true } },
        aiProvider: { select: { name: true } },
        outboundMessage: { select: { status: true } },
      },
    }),
    prisma.aiFallbackDecision.count({ where }),
    prisma.aiFallbackDecision.count({ where: { ...statsWhere, outcome: "AI_REPLIED" } }),
    prisma.aiFallbackDecision.count({ where: { ...statsWhere, outcome: "HUMAN_FALLBACK" } }),
    prisma.aiFallbackDecision.aggregate({
      where: { ...statsWhere, outcome: "AI_REPLIED" },
      _avg: { confidenceScore: true },
    }),
    prisma.aiFallbackDecision.aggregate({ where: statsWhere, _sum: { tokensUsed: true } }),
    prisma.whatsAppGroup.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const decided = repliedCount + handoffCount;
  const handoffRate = decided === 0 ? null : Math.round((handoffCount / decided) * 100);
  const avgConfidence = confidenceAgg._avg.confidenceScore;

  const rows: AiActivityRow[] = decisions.map((d) => ({
    id: d.id,
    timeLabel: formatDateTime(d.createdAt),
    outcome: d.outcome,
    reason: d.reason,
    intent: d.intent,
    confidenceScore: d.confidenceScore,
    customerMessage: d.message.body,
    messageId: d.message.id,
    groupId: d.group?.id ?? null,
    groupName: d.group?.name ?? null,
    senderLabel: d.message.senderName ?? d.message.senderPhone,
    responseText: d.responseText,
    providerName: d.aiProvider?.name ?? null,
    modelId: d.modelId,
    tokensUsed: d.tokensUsed,
    outboundStatus: d.outboundMessage?.status ?? null,
  }));

  const buildHref = (nextPage: number) => {
    const query = new URLSearchParams();
    if (params.outcome) query.set("outcome", params.outcome);
    if (params.groupId) query.set("groupId", params.groupId);
    query.set("window", windowKey);
    query.set("page", String(nextPage));
    return `/ai-learning/activity?${query.toString()}`;
  };

  const hasActiveFilters = Boolean(params.outcome || params.groupId || (params.window && params.window !== "7d"));

  return (
    <div>
      <PageHeader
        title="AI Activity"
        description="Every decision the AI fallback layer has made — what it replied, and where it handed off to a person."
        actions={
          <HelpButton moduleTitle="AI Activity">
            <HelpSection title="What this page is for">
              <p>
                One row per message the deterministic rule engine missed in a group where AI is
                allowed to answer. It is the only place that shows what the AI actually said to
                your customers without opening messages one at a time — worth watching closely for
                the first week after you switch AI automation on.
              </p>
            </HelpSection>
            <HelpSection title="Replied vs handed off">
              <p>
                "Replied" means the AI's answer cleared your confidence threshold and every safety
                gate, and was queued through the normal outbound queue. "Handed off" means it did
                not, so a human alert was sent instead — the customer received nothing from the AI.
                Either way nothing was sent twice, and rules always take precedence: the AI is only
                ever consulted when no rule matched.
              </p>
            </HelpSection>
            <HelpSection title="Reading the handoff reasons">
              <p>
                "AI_UNAVAILABLE" means no provider is configured for the RESPONSE job, or the AI
                engine is switched off — check AI Models and AI Settings. "LOW_CONFIDENCE" means the
                AI answered but below your threshold; a run of these suggests the threshold is too
                high for your traffic, or the questions genuinely need a person.
                "AI_DECLINED" is the AI choosing not to answer, which is usually correct.
                "SAFETY_BLOCKED" means a rate limit or cooldown stopped the send.
              </p>
            </HelpSection>
            <HelpSection title="What to do with a pattern">
              <p>
                If the same question keeps appearing here, it belongs in a rule rather than being
                answered by AI every time — a rule is instant, free, and identical every time. Turn
                on "Write rules from good answers" in AI Settings and the drafts will appear in Rule
                Proposals for you to approve.
              </p>
            </HelpSection>
            <HelpSection title="Costs">
              <p>
                Tokens are summed across the window and both outcomes, since a handoff for low
                confidence still spent a real API call. A handoff for "AI_UNAVAILABLE" did not —
                nothing was ever sent to a provider.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3.5 sm:grid-cols-4">
        <StatTile label="AI replied" value={repliedCount} tone={repliedCount > 0 ? "success" : "neutral"} />
        <StatTile
          label="Handed to a human"
          value={handoffCount}
          tone={handoffCount > 0 ? "warning" : "neutral"}
          hint={handoffRate === null ? undefined : `${handoffRate}% of decisions`}
        />
        <StatTile
          label="Avg confidence when replying"
          value={avgConfidence === null ? "—" : `${Math.round(avgConfidence)}%`}
        />
        <StatTile
          label="Tokens used"
          value={(tokenAgg._sum.tokensUsed ?? 0).toLocaleString("en-US")}
          hint={WINDOWS[windowKey]!.label.toLowerCase()}
        />
      </div>

      <FilterBar>
        <form className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[color:var(--color-muted-foreground)]">Period</span>
            <Select name="window" defaultValue={windowKey} className="w-44">
              {Object.entries(WINDOWS).map(([key, value]) => (
                <option key={key} value={key}>
                  {value.label}
                </option>
              ))}
            </Select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[color:var(--color-muted-foreground)]">Outcome</span>
            <Select name="outcome" defaultValue={params.outcome ?? ""} className="w-44">
              <option value="">All outcomes</option>
              <option value="AI_REPLIED">Replied</option>
              <option value="HUMAN_FALLBACK">Handed off</option>
            </Select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[color:var(--color-muted-foreground)]">Group</span>
            <Select name="groupId" defaultValue={params.groupId ?? ""} className="w-56">
              <option value="">All groups</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </Select>
          </label>

          <Button type="submit" size="sm">
            Apply
          </Button>
          {hasActiveFilters ? (
            <Link href="/ai-learning/activity" className="link text-xs">
              Clear
            </Link>
          ) : null}
        </form>
      </FilterBar>

      <AiActivityTable rows={rows} />
      <Pagination page={page} pageSize={PAGE_SIZE} total={total} buildHref={buildHref} />
    </div>
  );
}
