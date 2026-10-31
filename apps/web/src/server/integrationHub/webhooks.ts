import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { WebhookEvent } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { disabledFeaturesFor } from "@/server/projectFeatures";

/**
 * Raising a webhook event (INTEGRATION_HUB.md §Webhooks). Called after the change it describes is
 * committed, inside the project. It only QUEUES one delivery per subscribed endpoint; the delivery loop
 * sends them. Never throws: an event that could not be queued is logged, and the change itself stands.
 */
export async function emitWebhookEvent(event: WebhookEvent, data: Record<string, unknown>): Promise<void> {
  try {
    const projectId = await activeProjectId();
    if ((await disabledFeaturesFor(projectId)).has("API_ACCESS")) return;
    const endpoints = await prisma.webhookEndpoint.findMany({ where: { isActive: true, events: { has: event } }, select: { id: true } });
    if (endpoints.length === 0) return;
    const eventId = `evt_${randomUUID().replace(/-/g, "")}`;
    const payload = { id: eventId, event, createdAt: new Date().toISOString(), data } as Prisma.InputJsonValue;
    await prisma.webhookDelivery.createMany({
      data: endpoints.map((e) => ({ endpointId: e.id, event, eventId, payload })),
      skipDuplicates: true,
    });
  } catch (err) {
    console.error(`[webhooks] could not queue ${event}`, (err as Error).name);
  }
}

/** The common shape of an order in events and the public API. */
export function orderEventData(o: { id: string; number: string; status: string; paymentStatus: string; currency: string; totalMinor: bigint; paidMinor: bigint; customerName: string; customerPhone: string | null; externalSource?: string | null }) {
  return {
    orderId: o.id,
    number: o.number,
    status: o.status,
    paymentStatus: o.paymentStatus,
    currency: o.currency,
    total: (Number(o.totalMinor) / 100).toFixed(2),
    paid: (Number(o.paidMinor) / 100).toFixed(2),
    customer: { name: o.customerName, phone: o.customerPhone },
    source: o.externalSource ?? null,
  };
}
