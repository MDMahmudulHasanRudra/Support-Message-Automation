import { prisma } from "../db.js";
import type { AiSettings } from "@prisma/client";

/**
 * Guarantees the singleton AI settings row exists, defaulting to everything off.
 *
 * Reads first and only upserts when the row is genuinely absent — i.e. once, on a fresh install.
 * Exactly the shape, and the reasoning, of `pipeline/settings.ts`: an unconditional upsert takes a
 * ROW LOCK on the same single row and writes a tuple every time, and this row is read at the top of
 * every AI-related loop tick, once per incoming message in an AI-eligible group, and on every
 * knowledge, Forge and sandbox pass.
 *
 * Twelve call sites had their own copy of the unconditional version. At rest, with every optional
 * feature switched off, they were between them writing to this one row thousands of times a day to
 * discover that AI was still disabled — a lock, a tuple and an index update each, purely to answer
 * "no".
 *
 * Deliberately NOT cached with a TTL, for the same reason the automation settings are not:
 * switching AI off has to take effect immediately, and serving a stale value would be a safety
 * regression rather than an optimisation. A single-row primary-key lookup is already about as
 * cheap as a query gets; it is the WRITE that was the cost.
 */
export async function getAiSettings(): Promise<AiSettings> {
  const existing = await prisma.aiSettings.findUnique({ where: { id: "global" } });
  if (existing) return existing;
  return prisma.aiSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
}
