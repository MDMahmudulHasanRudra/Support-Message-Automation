import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { decryptSecret } from "@support-automation/db";
import { isPrivateAddress, nextWebhookAttempt, WEBHOOK_RETRY_DELAYS_MS } from "@support-automation/shared";
import { globalPrisma } from "@/server/db";
import { disabledFeaturesFor } from "@/server/projectFeatures";

/**
 * Sending queued webhook deliveries (INTEGRATION_HUB.md §Delivery). At least once: a delivery whose
 * answer was lost is sent again, and receivers deduplicate on the event id. Each request is signed:
 *
 *   X-GetAssist-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the endpoint secret>
 *
 * Before sending, the host is resolved and refused when any address it resolves to is private — a saved
 * public name must not be turned into a request inside our own network.
 */

const PER_TICK = 25;
const TIMEOUT_MS = 10_000;
const STUCK_MS = 5 * 60_000;

export function signWebhook(secret: string, body: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

async function hostIsPublic(url: string): Promise<boolean> {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (isPrivateAddress(host)) return false;
    const addresses = await lookup(host, { all: true });
    return addresses.length > 0 && addresses.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

async function settle(id: string, attempts: number, outcome: { ok: true; code: number } | { ok: false; code: number | null; error: string; final?: boolean }) {
  const now = new Date();
  if (outcome.ok) {
    await globalPrisma.webhookDelivery.update({ where: { id }, data: { status: "SUCCEEDED", attempts, lastStatusCode: outcome.code, lastError: null, deliveredAt: now } });
    return;
  }
  const next = outcome.final ? null : nextWebhookAttempt(attempts, now);
  await globalPrisma.webhookDelivery.update({
    where: { id },
    data: { status: next ? "PENDING" : "DEAD", attempts, lastStatusCode: outcome.code, lastError: outcome.error.slice(0, 300), ...(next ? { nextAttemptAt: next } : {}) },
  });
}

export async function deliverDueWebhooks(now = new Date()): Promise<number> {
  // A delivery left SENDING by a restart goes back in line (at least once).
  await globalPrisma.webhookDelivery.updateMany({ where: { status: "SENDING", updatedAt: { lt: new Date(now.getTime() - STUCK_MS) } }, data: { status: "PENDING" } });
  const due = await globalPrisma.webhookDelivery.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" },
    take: PER_TICK,
    include: { endpoint: { select: { url: true, secretCiphertext: true, isActive: true } }, project: { select: { status: true, billingHoldAt: true } } },
  });
  let sent = 0;
  for (const d of due) {
    const claimed = await globalPrisma.webhookDelivery.updateMany({ where: { id: d.id, status: "PENDING" }, data: { status: "SENDING" } });
    if (claimed.count !== 1) continue;
    const attempts = d.attempts + 1;
    if (!d.endpoint.isActive) {
      await settle(d.id, d.attempts, { ok: false, code: null, error: "The endpoint was switched off.", final: true });
      continue;
    }
    // A held project, or the feature switched off: the delivery waits rather than being lost.
    if (d.project.status !== "ACTIVE" || d.project.billingHoldAt || (await disabledFeaturesFor(d.projectId)).has("API_ACCESS")) {
      await globalPrisma.webhookDelivery.update({ where: { id: d.id }, data: { status: "PENDING", nextAttemptAt: new Date(now.getTime() + WEBHOOK_RETRY_DELAYS_MS[2]) } });
      continue;
    }
    if (!(await hostIsPublic(d.endpoint.url))) {
      await settle(d.id, attempts, { ok: false, code: null, error: "The address resolves to a private network address; not sent." });
      continue;
    }
    let secret: string;
    try {
      secret = decryptSecret(d.endpoint.secretCiphertext);
    } catch {
      await settle(d.id, attempts, { ok: false, code: null, error: "The endpoint's secret cannot be read; rotate it.", final: true });
      continue;
    }
    const body = JSON.stringify(d.payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(d.endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "GetAssist-Webhooks/1",
          "X-GetAssist-Event": d.event,
          "X-GetAssist-Event-Id": d.eventId,
          "X-GetAssist-Delivery": d.id,
          "X-GetAssist-Signature": signWebhook(secret, body, new Date()),
        },
        body,
        signal: controller.signal,
        redirect: "manual",
        cache: "no-store",
      });
      if (response.status >= 200 && response.status < 300) {
        await settle(d.id, attempts, { ok: true, code: response.status });
        sent += 1;
      } else {
        await settle(d.id, attempts, { ok: false, code: response.status, error: `The endpoint answered ${response.status}.` });
      }
    } catch (err) {
      await settle(d.id, attempts, { ok: false, code: null, error: (err as Error).name === "AbortError" ? "No answer within 10 seconds." : "The endpoint could not be reached." });
    } finally {
      clearTimeout(timer);
    }
  }
  return sent;
}
