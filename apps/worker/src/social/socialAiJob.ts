import { resolveAiClient, type AiClient } from "@support-automation/ai-client";
import { buildSocialAiPrompt, formatMinor, parseSocialAiOptions, validateSocialAiInput, type SocialAiProductFact } from "@support-automation/shared";
import { prisma } from "../db.js";
import { projectHasFeature } from "../project/features.js";
import { currentProjectId } from "../project/context.js";
import { getAiSettings } from "../ai/settings.js";

/**
 * Social Studio's AI Content Studio (SOCIAL_STUDIO.md §AI), answered in the worker because that is where
 * Get Assist's AI client lives: `resolveAiClient("RESPONSE")` — the project's own provider, model,
 * credentials and usage, exactly as every other AI feature. It writes only the SocialAiRequest row: no
 * post, no message, no notification. The answer is a suggestion a person puts into a draft, which still
 * needs approval.
 *
 * Gated on Social Studio being on for the project and the AI Engine switch; AI Copilot is NOT needed.
 * One request per project per tick, claimed PENDING → PROCESSING by a conditional update with a lease;
 * an abandoned claim is re-queued once, then failed (a lost call may have cost one completion).
 */

const LEASE_MS = 2 * 60_000;
const MAX_ATTEMPTS = 2;

export async function recoverStaleSocialAiRequests(now = new Date()): Promise<void> {
  const stale = { status: "PROCESSING", OR: [{ leaseExpiresAt: { lt: now } }, { leaseExpiresAt: null }] };
  await prisma.socialAiRequest.updateMany({ where: { ...stale, attempts: { gte: MAX_ATTEMPTS } }, data: { status: "FAILED", reason: "The AI stopped while working on this (the server restarted). Ask again.", completedAt: now, leaseExpiresAt: null } });
  await prisma.socialAiRequest.updateMany({ where: { ...stale, attempts: { lt: MAX_ATTEMPTS } }, data: { status: "PENDING", leaseExpiresAt: null } });
}

export async function processOneSocialAiRequest(clientOverride?: AiClient): Promise<void> {
  const now = new Date();
  if (!(await projectHasFeature("SOCIAL_STUDIO"))) {
    await prisma.socialAiRequest.updateMany({ where: { status: "PENDING" }, data: { status: "CANCELLED", reason: "Social Studio was switched off for this project.", completedAt: now } });
    return;
  }
  await recoverStaleSocialAiRequests(now);
  const pending = await prisma.socialAiRequest.findFirst({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, select: { id: true, attempts: true } });
  if (!pending) return;
  const claimed = await prisma.socialAiRequest.updateMany({
    where: { id: pending.id, status: "PENDING" },
    data: { status: "PROCESSING", attempts: { increment: 1 }, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) },
  });
  if (claimed.count === 0) return;
  const attempt = pending.attempts + 1;
  const mine = { id: pending.id, status: "PROCESSING", attempts: attempt };
  const finish = (data: { status: "COMPLETE" | "FAILED"; options?: string[]; reason?: string | null; providerId?: string | null; modelId?: string | null; tokensUsed?: number | null }) =>
    prisma.socialAiRequest.updateMany({ where: mine, data: { ...data, options: data.options ?? [], leaseExpiresAt: null, completedAt: new Date() } });

  try {
    const row = await prisma.socialAiRequest.findUniqueOrThrow({ where: { id: pending.id } });
    const input = validateSocialAiInput(row.input);
    if (!input.ok) {
      await finish({ status: "FAILED", reason: input.reason });
      return;
    }
    const settings = await getAiSettings();
    if (!settings.aiEngineEnabled) {
      await finish({ status: "FAILED", reason: "AI_UNAVAILABLE: the AI Engine is switched off (AI Learning → AI Settings)." });
      return;
    }
    let client: AiClient | null;
    try {
      client = clientOverride ?? (await resolveAiClient("RESPONSE", prisma));
    } catch (err) {
      await finish({ status: "FAILED", reason: `AI_UNAVAILABLE: ${(err as Error).message}`.slice(0, 500) });
      return;
    }
    if (!client) {
      await finish({ status: "FAILED", reason: "AI_UNAVAILABLE: no provider is assigned to the Response model, or it is disabled." });
      return;
    }

    // Product facts only for the products the person chose, only while the catalogue is on.
    const products: SocialAiProductFact[] = [];
    if (input.value.productIds.length && (await projectHasFeature("PRODUCT_CATALOG"))) {
      const rows = await prisma.product.findMany({ where: { id: { in: input.value.productIds }, status: "ACTIVE" }, select: { name: true, description: true, priceMinor: true, currency: true } });
      for (const p of rows) products.push({ name: p.name, price: formatMinor(p.priceMinor, p.currency), description: p.description });
    }
    const project = await prisma.project.findUnique({ where: { id: currentProjectId() }, select: { name: true } });
    const prompt = buildSocialAiPrompt(input.value, products, project?.name ?? null);
    const completion = await client.complete(prompt);
    const options = parseSocialAiOptions(completion.text, input.value.kind, input.value.count);
    await finish({
      status: options.length ? "COMPLETE" : "FAILED",
      options,
      reason: options.length ? null : "EMPTY_RESPONSE: the AI returned nothing usable. Try again or change the brief.",
      providerId: completion.providerId ?? null,
      modelId: completion.modelId ?? null,
      tokensUsed: completion.tokensUsed ?? null,
    });
  } catch (err) {
    await finish({ status: "FAILED", reason: `The AI request failed: ${(err as Error).message}`.slice(0, 500) });
  }
}
