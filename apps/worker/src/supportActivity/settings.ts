import { prisma } from "../db.js";
import type { SupportActivitySettings } from "@prisma/client";

/** Guarantees the singleton settings row exists, defaulting to disabled (opt-in feature). */
export async function getSupportActivitySettings(): Promise<SupportActivitySettings> {
  // Read first, upsert only when genuinely absent — the pattern pipeline/settings.ts already uses
  // and explains. An unconditional upsert takes a ROW LOCK and writes a tuple even when nothing
  // changes, and this is read from a polling loop: at rest, with every optional feature off, the
  // eight loops that opened this way were between them issuing roughly two hundred thousand
  // writes a day against a handful of single-row tables, before a single message arrived.
  const existing = await prisma.supportActivitySettings.findUnique({ where: { id: "global" } });
  if (existing) return existing;
  return prisma.supportActivitySettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
}
