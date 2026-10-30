"use server";

import { randomBytes, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { encryptSecret } from "@support-automation/db";
import { isApiScope, isWebhookEvent, webhookUrlProblem } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { newApiKey } from "@/server/integrationHub/apiKeys";

/**
 * Settings → API & Webhooks (INTEGRATION_HUB.md). `api.manage` throughout. A key and an endpoint secret are
 * returned ONCE, at creation (or rotation); afterwards only their first characters are shown.
 */

export interface HubResult {
  error?: string;
  success?: string;
  /** Shown once. */
  secret?: string;
}

const MAX_KEYS = 25;
const MAX_ENDPOINTS = 10;

async function revalidate() {
  revalidatePath(await projectPath("/settings/api"));
}

export async function createApiKey(name: string, scopes: string[], expiresInDays: number | null): Promise<HubResult> {
  const access = await checkPermission("api.manage");
  if ("denied" in access) return { error: access.denied };
  const clean = String(name ?? "").trim().slice(0, 80);
  if (!clean) return { error: "Name the key after what will use it (e.g. “n8n”, “Website”)." };
  const chosen = [...new Set((scopes ?? []).filter(isApiScope))];
  if (chosen.length === 0) return { error: "Choose at least one permission for the key." };
  if ((await prisma.apiKey.count({ where: { revokedAt: null } })) >= MAX_KEYS) return { error: `A workspace can have at most ${MAX_KEYS} active keys. Revoke one first.` };
  const days = expiresInDays && expiresInDays > 0 ? Math.min(3650, Math.trunc(expiresInDays)) : null;
  const { key, hash, prefix } = newApiKey();
  const row = await prisma.apiKey.create({
    data: { name: clean, prefix, keyHash: hash, scopes: chosen, createdByUsername: access.session.username, expiresAt: days ? new Date(Date.now() + days * 86_400_000) : null },
    select: { id: true },
  });
  await logSystemEvent("INFO", "integrations", `API key “${clean}” created`, { scopes: chosen, by: access.session.username }, { actorUserId: access.session.userId, targetType: "ApiKey", targetId: row.id });
  await revalidate();
  return { success: "Key created. Copy it now: it is not shown again.", secret: key };
}

export async function revokeApiKey(id: string): Promise<HubResult> {
  const access = await checkPermission("api.manage");
  if ("denied" in access) return { error: access.denied };
  const r = await prisma.apiKey.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(), revokedByUsername: access.session.username } });
  if (r.count !== 1) return { error: "That key is already revoked or no longer exists." };
  await logSystemEvent("INFO", "integrations", "API key revoked", { by: access.session.username }, { actorUserId: access.session.userId, targetType: "ApiKey", targetId: id });
  await revalidate();
  return { success: "Key revoked. Anything still using it is refused from now on." };
}

export interface EndpointInput {
  url: string;
  description: string;
  events: string[];
  isActive: boolean;
}

export async function saveWebhookEndpoint(id: string | null, input: EndpointInput): Promise<HubResult> {
  const access = await checkPermission("api.manage");
  if ("denied" in access) return { error: access.denied };
  const url = String(input.url ?? "").trim();
  const problem = webhookUrlProblem(url);
  if (problem) return { error: problem };
  if (url.length > 1000) return { error: "That address is too long." };
  const events = [...new Set((input.events ?? []).filter(isWebhookEvent))];
  if (events.length === 0) return { error: "Choose at least one event to send." };
  const data = { url, description: String(input.description ?? "").trim().slice(0, 200) || null, events, isActive: Boolean(input.isActive) };
  if (id) {
    const r = await prisma.webhookEndpoint.updateMany({ where: { id }, data });
    if (r.count !== 1) return { error: "That endpoint no longer exists." };
    await revalidate();
    return { success: "Endpoint saved." };
  }
  if ((await prisma.webhookEndpoint.count()) >= MAX_ENDPOINTS) return { error: `A workspace can have at most ${MAX_ENDPOINTS} webhook endpoints.` };
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const row = await prisma.webhookEndpoint.create({ data: { ...data, secretCiphertext: encryptSecret(secret), createdByUsername: access.session.username }, select: { id: true } });
  await logSystemEvent("INFO", "integrations", "Webhook endpoint added", { url: new URL(url).host, events, by: access.session.username }, { actorUserId: access.session.userId, targetType: "WebhookEndpoint", targetId: row.id });
  await revalidate();
  return { success: "Endpoint added. Copy its signing secret now: it is not shown again.", secret };
}

export async function rotateWebhookSecret(id: string): Promise<HubResult> {
  const access = await checkPermission("api.manage");
  if ("denied" in access) return { error: access.denied };
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const r = await prisma.webhookEndpoint.updateMany({ where: { id }, data: { secretCiphertext: encryptSecret(secret) } });
  if (r.count !== 1) return { error: "That endpoint no longer exists." };
  await logSystemEvent("INFO", "integrations", "Webhook secret rotated", { by: access.session.username }, { actorUserId: access.session.userId, targetType: "WebhookEndpoint", targetId: id });
  await revalidate();
  return { success: "New secret made. Deliveries from now on are signed with it.", secret };
}

export async function deleteWebhookEndpoint(id: string): Promise<HubResult> {
  const access = await checkPermission("api.manage");
  if ("denied" in access) return { error: access.denied };
  const r = await prisma.webhookEndpoint.deleteMany({ where: { id } });
  if (r.count !== 1) return { error: "That endpoint no longer exists." };
  await logSystemEvent("INFO", "integrations", "Webhook endpoint deleted", { by: access.session.username }, { actorUserId: access.session.userId, targetType: "WebhookEndpoint", targetId: id });
  await revalidate();
  return { success: "Endpoint deleted, with its delivery history." };
}

/** Queue a `ping` to one endpoint, to check the address and the signature check on the other side. */
export async function sendTestWebhook(id: string): Promise<HubResult> {
  const access = await checkPermission("api.manage");
  if ("denied" in access) return { error: access.denied };
  const endpoint = await prisma.webhookEndpoint.findFirst({ where: { id }, select: { id: true } });
  if (!endpoint) return { error: "That endpoint no longer exists." };
  const eventId = `evt_${randomUUID().replace(/-/g, "")}`;
  await prisma.webhookDelivery.create({
    data: { endpointId: id, event: "ping", eventId, payload: { id: eventId, event: "ping", createdAt: new Date().toISOString(), data: { message: "Test from Get Assist" } } as Prisma.InputJsonValue },
  });
  await revalidate();
  return { success: "Test queued. It is sent within a minute; its result appears in the delivery list." };
}

/** Send a DEAD delivery again (attempts start over). */
export async function retryWebhookDelivery(id: string): Promise<HubResult> {
  const access = await checkPermission("api.manage");
  if ("denied" in access) return { error: access.denied };
  const r = await prisma.webhookDelivery.updateMany({ where: { id, status: "DEAD" }, data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), lastError: null } });
  if (r.count !== 1) return { error: "Only a delivery that gave up can be retried." };
  await revalidate();
  return { success: "Queued again." };
}
