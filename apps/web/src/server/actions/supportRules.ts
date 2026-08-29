"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@support-automation/db";
import type { SupportActivityTriggerType } from "@prisma/client";
import { requireSession } from "@/server/auth";

const VALID_TRIGGER_TYPES: SupportActivityTriggerType[] = [
  "KEYWORD_MATCH",
  "REPLY_TO_CUSTOMER",
  "MENTION",
  "ANY_MESSAGE",
];

interface ParsedRuleForm {
  name: string;
  description: string | null;
  triggerType: SupportActivityTriggerType;
  appliesToAllGroups: boolean;
  groupIds: string[];
  appliesToAllTeamMembers: boolean;
  teamMemberIds: string[];
  keywordIds: string[];
}

function parseRuleForm(formData: FormData): ParsedRuleForm {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Rule name is required.");

  const triggerTypeRaw = String(formData.get("triggerType") ?? "KEYWORD_MATCH");
  if (!VALID_TRIGGER_TYPES.includes(triggerTypeRaw as SupportActivityTriggerType)) {
    throw new Error("Invalid trigger type.");
  }
  const triggerType = triggerTypeRaw as SupportActivityTriggerType;

  return {
    name,
    description: String(formData.get("description") ?? "").trim() || null,
    triggerType,
    appliesToAllGroups: formData.get("appliesToAllGroups") === "on",
    groupIds: formData.getAll("groupIds").map(String),
    appliesToAllTeamMembers: formData.get("appliesToAllTeamMembers") === "on",
    teamMemberIds: formData.getAll("teamMemberIds").map(String),
    // Keywords only matter for KEYWORD_MATCH — never stored for the other trigger types, even if
    // the form somehow submitted some (e.g. a stale client state).
    keywordIds: triggerType === "KEYWORD_MATCH" ? formData.getAll("keywordIds").map(String) : [],
  };
}

/** The name the one-click setup uses, so re-running it finds its own rule instead of adding another.
 *  Not exported: every export of a "use server" module has to be an async server action. */
const COUNT_EVERY_MESSAGE_RULE_NAME = "Count every team member message";

export interface EnsureRuleResult {
  created: boolean;
  reactivated: boolean;
}

/**
 * The one-click answer to "count it whenever any of my people writes in any group".
 *
 * Support Activity needs three things true at once — the feature enabled, a rule that matches,
 * and the sender on the team roster — and with any one missing the dashboard simply reads
 * "no support activity detected yet", which looks like nothing happened rather than like nothing
 * was configured. This collapses the rule half into a single action.
 *
 * Idempotent by name: running it again reactivates the existing rule rather than stacking up
 * duplicates that would each match every message.
 */
export async function enableCountEveryTeamMemberMessage(): Promise<EnsureRuleResult> {
  await requireSession();

  const existing = await prisma.supportRule.findFirst({
    where: { name: COUNT_EVERY_MESSAGE_RULE_NAME, triggerType: "ANY_MESSAGE" },
  });

  if (existing) {
    const reactivated = !existing.isActive;
    if (reactivated) {
      await prisma.supportRule.update({ where: { id: existing.id }, data: { isActive: true } });
    }
    await prisma.supportActivitySettings.upsert({
      where: { id: "global" },
      update: { enabled: true },
      create: { id: "global", enabled: true },
    });
    revalidatePath("/support-activity");
    revalidatePath("/support-activity/rules");
    revalidatePath("/support-activity/settings");
    return { created: false, reactivated };
  }

  await prisma.supportRule.create({
    data: {
      name: COUNT_EVERY_MESSAGE_RULE_NAME,
      description:
        "Records one support activity for every message a team member sends in a monitored group — no keyword, reply or mention needed.",
      triggerType: "ANY_MESSAGE",
      appliesToAllGroups: true,
      appliesToAllTeamMembers: true,
      isActive: true,
    },
  });

  // Turning the rule on without the master switch would still count nothing, which is exactly
  // the half-configured state this action exists to prevent.
  await prisma.supportActivitySettings.upsert({
    where: { id: "global" },
    update: { enabled: true },
    create: { id: "global", enabled: true },
  });

  revalidatePath("/support-activity");
  revalidatePath("/support-activity/rules");
  revalidatePath("/support-activity/settings");
  return { created: true, reactivated: false };
}

export async function createSupportRule(formData: FormData): Promise<void> {
  await requireSession();
  const parsed = parseRuleForm(formData);

  await prisma.$transaction(async (tx) => {
    const rule = await tx.supportRule.create({
      data: {
        name: parsed.name,
        description: parsed.description,
        triggerType: parsed.triggerType,
        appliesToAllGroups: parsed.appliesToAllGroups,
        appliesToAllTeamMembers: parsed.appliesToAllTeamMembers,
        isActive: true,
      },
    });
    if (parsed.keywordIds.length) {
      await tx.supportRuleKeyword.createMany({ data: parsed.keywordIds.map((keywordId) => ({ ruleId: rule.id, keywordId })) });
    }
    if (!parsed.appliesToAllGroups && parsed.groupIds.length) {
      await tx.supportRuleGroup.createMany({ data: parsed.groupIds.map((groupId) => ({ ruleId: rule.id, groupId })) });
    }
    if (!parsed.appliesToAllTeamMembers && parsed.teamMemberIds.length) {
      await tx.supportRuleTeamMember.createMany({
        data: parsed.teamMemberIds.map((teamMemberId) => ({ ruleId: rule.id, teamMemberId })),
      });
    }
  });

  revalidatePath("/support-activity/rules");
  redirect("/support-activity/rules");
}

export async function updateSupportRule(id: string, formData: FormData): Promise<void> {
  await requireSession();
  const parsed = parseRuleForm(formData);

  await prisma.$transaction(async (tx) => {
    await tx.supportRule.update({
      where: { id },
      data: {
        name: parsed.name,
        description: parsed.description,
        triggerType: parsed.triggerType,
        appliesToAllGroups: parsed.appliesToAllGroups,
        appliesToAllTeamMembers: parsed.appliesToAllTeamMembers,
      },
    });

    // Replace the join-table rows wholesale — simplest correct approach for a form that submits
    // the full desired set each time (matches the scale of this feature: a handful of rules, not
    // thousands, so a delete+recreate per save is cheap and avoids diffing logic).
    await tx.supportRuleKeyword.deleteMany({ where: { ruleId: id } });
    if (parsed.keywordIds.length) {
      await tx.supportRuleKeyword.createMany({ data: parsed.keywordIds.map((keywordId) => ({ ruleId: id, keywordId })) });
    }

    await tx.supportRuleGroup.deleteMany({ where: { ruleId: id } });
    if (!parsed.appliesToAllGroups && parsed.groupIds.length) {
      await tx.supportRuleGroup.createMany({ data: parsed.groupIds.map((groupId) => ({ ruleId: id, groupId })) });
    }

    await tx.supportRuleTeamMember.deleteMany({ where: { ruleId: id } });
    if (!parsed.appliesToAllTeamMembers && parsed.teamMemberIds.length) {
      await tx.supportRuleTeamMember.createMany({
        data: parsed.teamMemberIds.map((teamMemberId) => ({ ruleId: id, teamMemberId })),
      });
    }
  });

  revalidatePath("/support-activity/rules");
  redirect("/support-activity/rules");
}

export async function toggleSupportRuleActive(id: string): Promise<void> {
  await requireSession();
  const rule = await prisma.supportRule.findUniqueOrThrow({ where: { id } });
  await prisma.supportRule.update({ where: { id }, data: { isActive: !rule.isActive } });
  revalidatePath("/support-activity/rules");
}

export async function deleteSupportRule(id: string): Promise<void> {
  await requireSession();
  await prisma.supportRule.delete({ where: { id } }); // cascades its join-table rows
  revalidatePath("/support-activity/rules");
}
