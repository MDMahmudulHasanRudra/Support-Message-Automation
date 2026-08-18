"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@support-automation/db";
import type { SupportActivityTriggerType } from "@prisma/client";
import { requireSession } from "@/server/auth";

const VALID_TRIGGER_TYPES: SupportActivityTriggerType[] = ["KEYWORD_MATCH", "REPLY_TO_CUSTOMER", "MENTION"];

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
