"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";

/** Mirrors supportRules.ts's create/update shape — no group/team-member scoping here (unlike
 * SupportRule) since a resolution rule applies to every Teams message evaluated against an
 * already-linked SupportIssue; scoping happens via the issue's own teamsChannelId/
 * teamsThreadExternalId, not the rule. */

function parseRuleForm(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Rule name is required.");
  return {
    name,
    description: String(formData.get("description") ?? "").trim() || null,
    keywordIds: formData.getAll("keywordIds").map(String),
  };
}

export async function createTeamsResolutionRule(formData: FormData): Promise<void> {
  await requireSession();
  const parsed = parseRuleForm(formData);

  await prisma.$transaction(async (tx) => {
    const rule = await tx.teamsResolutionRule.create({
      data: { name: parsed.name, description: parsed.description, isActive: true },
    });
    if (parsed.keywordIds.length) {
      await tx.teamsResolutionRuleKeyword.createMany({
        data: parsed.keywordIds.map((keywordId) => ({ ruleId: rule.id, keywordId })),
      });
    }
  });

  revalidatePath("/integrations/teams/rules");
  redirect("/integrations/teams/rules");
}

export async function updateTeamsResolutionRule(id: string, formData: FormData): Promise<void> {
  await requireSession();
  const parsed = parseRuleForm(formData);

  await prisma.$transaction(async (tx) => {
    await tx.teamsResolutionRule.update({ where: { id }, data: { name: parsed.name, description: parsed.description } });
    await tx.teamsResolutionRuleKeyword.deleteMany({ where: { ruleId: id } });
    if (parsed.keywordIds.length) {
      await tx.teamsResolutionRuleKeyword.createMany({
        data: parsed.keywordIds.map((keywordId) => ({ ruleId: id, keywordId })),
      });
    }
  });

  revalidatePath("/integrations/teams/rules");
  redirect("/integrations/teams/rules");
}

export async function toggleTeamsResolutionRuleActive(id: string): Promise<void> {
  await requireSession();
  const rule = await prisma.teamsResolutionRule.findUniqueOrThrow({ where: { id } });
  await prisma.teamsResolutionRule.update({ where: { id }, data: { isActive: !rule.isActive } });
  revalidatePath("/integrations/teams/rules");
}

export async function deleteTeamsResolutionRule(id: string): Promise<void> {
  await requireSession();
  await prisma.teamsResolutionRule.delete({ where: { id } }); // cascades its join-table rows
  revalidatePath("/integrations/teams/rules");
}
