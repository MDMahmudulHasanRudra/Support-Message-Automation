/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import Link from "next/link";
import { Plus } from "lucide-react";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Button, HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/date";
import { isRuleActionArray, isRuleConditions } from "@support-automation/shared";
import { RulesTable, type RuleRow } from "./RulesTable";

export default async function RulesPage() {
  await requireSession();
  const rules = await prisma.automationRule.findMany({ orderBy: [{ priority: "desc" }, { createdAt: "desc" }] });

  const priorityCounts = new Map<number, number>();
  for (const rule of rules) {
    priorityCounts.set(rule.priority, (priorityCounts.get(rule.priority) ?? 0) + 1);
  }

  const rows: RuleRow[] = rules.map((rule) => {
    const actions = isRuleActionArray(rule.actions) ? rule.actions : [];
    const conditions = isRuleConditions(rule.conditions) ? rule.conditions : {};
    const trigger =
      rule.matchType +
      (rule.matchValue ? `: ${rule.matchValue}` : rule.keywords.length ? `: ${rule.keywords.join(", ")}` : "");
    return {
      id: rule.id,
      name: rule.name,
      type: rule.type,
      trigger,
      actionsSummary: actions.map((a) => a.type).join(", ") || "—",
      priority: rule.priority,
      status: rule.status,
      executionCount: rule.executionCount,
      updatedAtLabel: formatDate(rule.updatedAt),
      hasPriorityConflict: (priorityCounts.get(rule.priority) ?? 0) > 1,
      hasSchedule: Boolean(conditions.timeWindow),
    };
  });

  return (
    <div>
      <PageHeader
        title="Automation Rules"
        description="Higher priority rules are evaluated first."
        actions={
          <>
            <HelpButton moduleTitle="Automation Rules">
              <HelpSection title="What this page is for">
                <p>
                  Rules decide what happens to an incoming message — tag it, auto-reply, flag it for a
                  human, notify Teams/WhatsApp, forward it. Every ACTIVE rule is checked against every
                  incoming message; the highest-priority rule whose conditions AND trigger both match
                  wins, and only its actions run. Use Rule Tester to check your logic before relying on
                  it live.
                </p>
              </HelpSection>
              <HelpSection title="Priority — how the winner is picked">
                <p>
                  Rules are checked from highest priority number down to lowest; the first one whose
                  conditions and trigger both match wins, and evaluation stops there — lower-priority
                  rules never get a chance to run for that message. Two rules sharing the same priority
                  number is flagged with a warning icon — ties are broken by database order, which
                  isn't something you can predict or control, so give them different priorities instead.
                </p>
              </HelpSection>
              <HelpSection title="Trigger (Match Type)">
                <p>
                  <strong>ALWAYS</strong> matches every message. <strong>KEYWORDS</strong> matches if any
                  comma-separated keyword appears anywhere in the message. <strong>EXACT</strong>/
                  <strong>CONTAINS</strong> compare against one exact string. <strong>REGEX</strong> is
                  validated server-side for length/complexity before it can be saved, to block patterns
                  that could hang the server.
                </p>
              </HelpSection>
              <HelpSection title="Conditions — narrow down WHEN a trigger counts">
                <p>
                  Current/Previous Sender scope a rule to team-member or client senders specifically.
                  Group Scope limits it to specific WhatsApp groups. And "Only active during specific
                  hours" lets you give a rule a schedule — e.g. 22:00 to 06:00 — so it only fires
                  overnight and is otherwise inert, with no need to remember to disable it manually.
                  Overnight windows are fully supported; the clock icon in the Trigger column marks any
                  rule that has a schedule configured.
                </p>
              </HelpSection>
              <HelpSection title="Auto-Reply Safety fields">
                <p>
                  Only shown when the AUTO_REPLY action is checked. <strong>Cooldown</strong> stops the
                  same rule from replying to the same client again within N seconds — even if they keep
                  messaging. <strong>Reply delay min/max</strong> is a random wait before actually
                  sending, so replies look human rather than instant. These are on top of the account-wide
                  rate limits configured on the Settings page.
                </p>
              </HelpSection>
              <HelpSection title="Manage column">
                <p>
                  <strong>Duplicate</strong> creates a DRAFT copy with everything (including a schedule,
                  if any) preserved — handy for variations of an existing rule. <strong>Disable</strong>{" "}
                  stops a rule from being evaluated at all without deleting it. <strong>Delete</strong>{" "}
                  is permanent.
                </p>
              </HelpSection>
            </HelpButton>
            <Link href="/rules/new">
              <Button>
                <Plus className="size-3.5" aria-hidden />
                Create Rule
              </Button>
            </Link>
          </>
        }
      />

      <RulesTable rules={rows} />
    </div>
  );
}
