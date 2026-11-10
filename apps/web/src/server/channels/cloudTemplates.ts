import { decryptSecret } from "@support-automation/db";
import { readCloudTemplate, renderCloudTemplate, validateChannelText } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { listCloudTemplates, type FetchImpl } from "@/server/channels/providerApi";
import { connectionProblem } from "@/server/channels/inbox";

/**
 * Message templates for WhatsApp (Official API) (WHATSAPP_OFFICIAL.md). A template is the only thing WhatsApp allows after 24 hours, and Meta
 * charges for it, so it goes out one at a time, into a conversation the customer started, by a person pressing send. There is no bulk path here.
 */

export class CloudTemplateError extends Error {}

export async function syncCloudTemplates(connectionId: string, fetchImpl: FetchImpl = fetch): Promise<{ count: number }> {
  const connection = await prisma.channelConnection.findFirst({ where: { id: connectionId, type: "WHATSAPP_CLOUD" }, select: { id: true, wabaId: true, accessTokenCiphertext: true, appSecretCiphertext: true } });
  if (!connection?.wabaId || !connection.accessTokenCiphertext || !connection.appSecretCiphertext) throw new CloudTemplateError("This number's account details are incomplete.");
  const listed = await listCloudTemplates(connection.wabaId, decryptSecret(connection.accessTokenCiphertext), decryptSecret(connection.appSecretCiphertext), fetchImpl);
  if (!listed.ok) throw new CloudTemplateError(listed.error.message);
  const now = new Date();
  const rows = listed.data.flatMap((raw) => readCloudTemplate(raw) ?? []);
  await prisma.$transaction(async (tx) => {
    for (const t of rows) {
      await tx.whatsAppCloudTemplate.upsert({
        where: { connectionId_name_language: { connectionId, name: t.name, language: t.language } },
        create: { connectionId, ...t, syncedAt: now },
        update: { category: t.category, status: t.status, bodyText: t.bodyText, paramCount: t.paramCount, supported: t.supported, syncedAt: now },
      });
    }
    // A template deleted at Meta must not stay on offer.
    await tx.whatsAppCloudTemplate.deleteMany({ where: { connectionId, syncedAt: { lt: now } } });
  });
  return { count: rows.length };
}

export async function usableTemplates(conversationId: string) {
  const conversation = await prisma.channelConversation.findFirst({ where: { id: conversationId, type: "WHATSAPP_CLOUD" }, select: { connectionId: true } });
  if (!conversation) return [];
  return prisma.whatsAppCloudTemplate.findMany({ where: { connectionId: conversation.connectionId, status: "APPROVED", supported: true }, orderBy: { name: "asc" }, select: { id: true, name: true, language: true, category: true, bodyText: true, paramCount: true } });
}

export async function queueCloudTemplate(input: { conversationId: string; templateId: string; params: string[]; nonce: string; userId: string }): Promise<{ messageId: string; duplicate: boolean }> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(input.nonce)) throw new CloudTemplateError("This message could not be identified. Reload the page and try again.");
  const conversation = await prisma.channelConversation.findFirst({
    where: { id: input.conversationId, type: "WHATSAPP_CLOUD" },
    select: { id: true, type: true, connectionId: true, kind: true, lastInboundAt: true, connection: { select: { name: true, status: true, enabled: true } } },
  });
  if (!conversation) throw new CloudTemplateError("That conversation no longer exists.");
  // A person the customer has written to, never a cold number.
  if (!conversation.lastInboundAt) throw new CloudTemplateError("A template can only go to somebody who has messaged you.");
  const problem = connectionProblem({ connectionStatus: conversation.connection.status, connectionEnabled: conversation.connection.enabled, connectionName: conversation.connection.name });
  if (problem) throw new CloudTemplateError(problem);

  const template = await prisma.whatsAppCloudTemplate.findFirst({ where: { id: input.templateId, connectionId: conversation.connectionId, status: "APPROVED", supported: true } });
  if (!template) throw new CloudTemplateError("That template is not approved for this number.");
  const params = input.params.map((p) => String(p ?? "").trim().replace(/\s+/g, " "));
  if (params.length !== template.paramCount || params.some((p) => !p || p.length > 1024)) throw new CloudTemplateError("Fill in every blank in the template.");
  const text = renderCloudTemplate(template.bodyText, params);
  const invalid = validateChannelText(conversation.type, text);
  if (invalid) throw new CloudTemplateError(invalid);

  const idempotencyKey = `template:${conversation.id}:${input.nonce}`;
  const projectId = await activeProjectId();
  const existing = await prisma.channelMessage.findUnique({ where: { projectId_idempotencyKey: { projectId, idempotencyKey } }, select: { id: true } });
  if (existing) return { messageId: existing.id, duplicate: true };
  const now = new Date();
  const created = await prisma.channelMessage.create({
    data: { conversationId: conversation.id, connectionId: conversation.connectionId, type: conversation.type, direction: "OUTBOUND", senderType: "AGENT", createdByUserId: input.userId, text, contentType: "TEXT", occurredAt: now, deliveryStatus: "QUEUED", idempotencyKey, templateName: template.name, templateLanguage: template.language, templateParams: params },
    select: { id: true },
  });
  return { messageId: created.id, duplicate: false };
}
