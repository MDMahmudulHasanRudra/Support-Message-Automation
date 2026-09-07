"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import {
  getTemplateDefinition,
  isNotificationTemplateKey,
  renderNotificationTemplate,
  validateTemplateBody,
} from "@support-automation/shared";
import { requireSession } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";

/**
 * Saving and resetting the wording of the messages this system sends.
 *
 * Two things are load-bearing here:
 *
 * **Reset deletes the row.** It does not write the current default into the table. An unedited
 * template then keeps tracking whatever the built-in wording becomes, which is the whole reason
 * defaults live in code — copying them into the database on reset would freeze each one at
 * whatever it happened to say on the day somebody clicked the button.
 *
 * **Validation happens here, not only in the browser.** A placeholder that does not exist renders
 * as a literal `{{typo}}` in front of a customer, and the client-side check is a convenience that
 * a stale tab or a direct action call goes straight past.
 */

export interface TemplateActionState {
  error?: string;
  saved?: boolean;
}

export async function updateNotificationTemplate(
  _prev: TemplateActionState,
  formData: FormData,
): Promise<TemplateActionState> {
  const session = await requireSession();

  const key = String(formData.get("key") ?? "");
  if (!isNotificationTemplateKey(key)) return { error: "That template does not exist." };

  const body = String(formData.get("body") ?? "").replace(/\r\n/g, "\n");
  const verdict = validateTemplateBody(key, body);
  if (verdict.error) return { error: verdict.error };

  await prisma.notificationTemplate.upsert({
    where: { key },
    update: { body: body.trim(), updatedById: session.userId },
    create: { key, body: body.trim(), updatedById: session.userId },
  });

  // WARN rather than INFO: this changes what customers and on-call staff actually read, and when
  // an alert later reads oddly the first question is when the wording last moved.
  await logSystemEvent("WARN", "notifications", `Notification template "${key}" edited`, {
    key,
    editedBy: session.username,
  });

  revalidatePath("/notifications/templates");
  return { saved: true };
}

export async function resetNotificationTemplate(key: string): Promise<TemplateActionState> {
  const session = await requireSession();
  if (!isNotificationTemplateKey(key)) return { error: "That template does not exist." };

  // deleteMany, not delete: resetting a template nobody had customised is a no-op the operator
  // should not see an error for.
  const { count } = await prisma.notificationTemplate.deleteMany({ where: { key } });
  if (count > 0) {
    await logSystemEvent("WARN", "notifications", `Notification template "${key}" reset to default`, {
      key,
      resetBy: session.username,
    });
  }

  revalidatePath("/notifications/templates");
  return { saved: true };
}

export interface TemplateTestSendResult {
  error?: string;
  queued?: boolean;
}

/**
 * Sends the previewed message to a chosen group, so it can be read on a real phone.
 *
 * The preview shows the text; it cannot show what WhatsApp does with it. Line breaks collapse
 * differently, emoji render at a different weight, and — for the one customer-facing template —
 * an @-mention only becomes a tag when a real client renders it. That template is the one nobody
 * should be guessing about, and it is the one a preview can least help with.
 *
 * Goes through the outbound queue as a MANUAL_REPLY, not a second send path: a person pressed a
 * button, so the kill switch correctly does not cancel it and a rate limit defers rather than
 * discards it. Sample values are used, and the body is prefixed, because this lands in a real
 * conversation and must never be mistaken for a genuine alert.
 */
export async function sendTemplateTestMessage(key: string, groupId: string): Promise<TemplateTestSendResult> {
  const session = await requireSession();

  const definition = getTemplateDefinition(key);
  if (!definition) return { error: "That template does not exist." };
  if (!groupId) return { error: "Choose a group to send the test to." };

  const group = await prisma.whatsAppGroup.findUnique({
    where: { id: groupId },
    select: {
      id: true,
      name: true,
      whatsappGroupId: true,
      accountId: true,
      isActive: true,
      account: { select: { label: true, status: true } },
    },
  });
  if (!group) return { error: "That group no longer exists." };
  if (!group.isActive) {
    return { error: `This account is no longer a member of ${group.name}, so nothing can be sent there.` };
  }
  if (group.account.status !== "CONNECTED") {
    return { error: `${group.account.label} is ${group.account.status.toLowerCase()}. Reconnect it first.` };
  }

  const override = await prisma.notificationTemplate.findUnique({ where: { key } });
  const body = renderNotificationTemplate(
    override?.body ?? definition.defaultBody,
    Object.fromEntries(definition.variables.map((v) => [v.name, v.sample])),
  );
  if (!body.trim()) return { error: "This template renders as an empty message — nothing to send." };

  // The label is not optional. This goes into a real conversation, and an escalation alert
  // arriving with invented customer details would be acted on as if a customer were waiting.
  const labelled = `🧪 TEST — sample values, no action needed\n\n${body}`;

  try {
    await prisma.outboundMessage.create({
      data: {
        accountId: group.accountId,
        chatId: group.whatsappGroupId,
        toPhone: group.whatsappGroupId,
        body: labelled,
        actionType: "MANUAL_REPLY",
        // Timestamped rather than keyed on the text: sending the same template twice while
        // comparing wording is the normal way to use this, and the second send must not be
        // silently swallowed as a duplicate.
        idempotencyKey: `template-test:${key}:${group.id}:${Date.now()}`,
        groupId: group.id,
        groupNameSnapshot: group.name,
        createdById: session.userId,
      },
    });
  } catch (err) {
    await logSystemEvent("ERROR", "notifications", "Failed to queue a template test message", {
      key,
      groupId: group.id,
      error: (err as Error).message,
    });
    return { error: "Could not queue the test message. Check System Logs for the reason." };
  }

  await logSystemEvent("INFO", "notifications", `Test message sent for template "${key}"`, {
    key,
    groupName: group.name,
    sentBy: session.username,
  });
  return { queued: true };
}
