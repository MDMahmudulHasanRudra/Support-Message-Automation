import { OPEN_SHIPMENT_STATUSES } from "@support-automation/shared";
import { globalPrisma } from "@/server/db";
import { runWithProject } from "@/server/projectContext";
import { disabledFeaturesFor } from "@/server/projectFeatures";
import { refreshShipment } from "@/server/integrations/shipments";
import { deliverDueWebhooks } from "@/server/integrationHub/webhookDelivery";

/**
 * Background work for integrations, in the APP process like the Smart Import processor (instrumentation.ts):
 *   - courier status refresh: open shipments not checked for 30 minutes, 20 per tick, oldest first;
 *   - outbound webhook delivery (INTEGRATION_HUB.md): due deliveries, with retries.
 * Overlap-guarded; never throws. A suspended or billing-held project, or one with the feature off, is
 * skipped. INTEGRATIONS_PROCESSOR_DISABLED=true leaves it off.
 */

const TICK_MS = 60_000;
const SHIPMENT_STALE_MS = 30 * 60_000;
const SHIPMENTS_PER_TICK = 20;

async function projectFor(projectId: string) {
  const p = await globalPrisma.project.findUnique({ where: { id: projectId }, select: { id: true, slug: true, name: true, status: true, customerId: true, billingHoldAt: true } });
  if (!p || p.status !== "ACTIVE" || p.billingHoldAt) return null;
  return { id: p.id, slug: p.slug, name: p.name, status: p.status, tenant: p.customerId };
}

export async function refreshDueShipments(now = new Date()): Promise<number> {
  const due = await globalPrisma.shipment.findMany({
    where: { status: { in: [...OPEN_SHIPMENT_STATUSES] }, connectionId: { not: null }, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(now.getTime() - SHIPMENT_STALE_MS) } }] },
    orderBy: { lastCheckedAt: { sort: "asc", nulls: "first" } },
    take: SHIPMENTS_PER_TICK,
    select: { id: true, projectId: true },
  });
  let done = 0;
  for (const s of due) {
    const project = await projectFor(s.projectId);
    if (!project || (await disabledFeaturesFor(project.id)).has("COURIER")) continue;
    try {
      await runWithProject(project, () => refreshShipment(s.id, null));
      done += 1;
    } catch (err) {
      console.error("[courier] background refresh failed", (err as Error).name);
    }
  }
  return done;
}

let running = false;

export async function integrationsTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await refreshDueShipments().catch((err) => console.error("[courier] refresh tick failed", (err as Error).name));
    await deliverDueWebhooks().catch((err) => console.error("[webhooks] delivery tick failed", (err as Error).name));
  } finally {
    running = false;
  }
}

let started = false;

export function startIntegrationsProcessor(): void {
  if (started) return;
  started = true;
  const timer = setInterval(() => void integrationsTick(), TICK_MS);
  timer.unref?.();
}
