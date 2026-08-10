import { notFound } from "next/navigation";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
import { updateRule } from "@/server/actions/rules";
import { isRuleActionArray, isRuleConditions } from "@support-automation/shared";
import { RuleForm, type RuleFormDefaults } from "../../RuleForm";

export default async function EditRulePage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  const rule = await prisma.automationRule.findUnique({ where: { id } });
  if (!rule) notFound();

  const conditions = isRuleConditions(rule.conditions) ? rule.conditions : {};
  const actions = isRuleActionArray(rule.actions) ? rule.actions : [];
  const tagAction = actions.find((a) => a.type === "TAG");
  const supportAction = actions.find((a) => a.type === "SUPPORT_REQUIRED");
  const forwardAction = actions.find((a) => a.type === "FORWARD");

  const defaults: RuleFormDefaults = {
    name: rule.name,
    description: rule.description ?? undefined,
    type: rule.type,
    matchType: rule.matchType,
    matchValue: rule.matchValue ?? undefined,
    keywords: rule.keywords,
    priority: rule.priority,
    status: rule.status,
    cooldownSeconds: rule.cooldownSeconds,
    replyMessage: rule.replyMessage ?? undefined,
    replyDelayMinMs: rule.replyDelayMinMs,
    replyDelayMaxMs: rule.replyDelayMaxMs,
    senderType: conditions.sender?.type ?? "ANY",
    previousSenderType: conditions.previousSender?.type ?? "NONE",
    groupIds: conditions.groupScope?.groupIds?.join(", ") ?? "",
    actionTypes: actions.map((a) => a.type),
    actionTag: tagAction?.tag,
    actionCategory: supportAction?.category,
    actionForwardChatId: forwardAction?.forwardToChatId,
  };

  return (
    <div>
      <PageHeader title={`Edit Rule: ${rule.name}`} />
      <RuleForm action={updateRule.bind(null, rule.id)} defaults={defaults} submitLabel="Save Changes" />
    </div>
  );
}
