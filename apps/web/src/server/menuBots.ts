import { readMenuTree, type MenuBotChannel, type MenuTree } from "@support-automation/shared";
import { prisma } from "@/server/db";

/** Menu bots (MENU_BOTS.md): the readings. Through the project-scoped client, so another project's bot is not found. */

const DAY = 86_400_000;

function tally(rows: Array<{ kind: string; _count: { _all: number } }>) {
  const n = (kind: string) => rows.find((r) => r.kind === kind)?._count._all ?? 0;
  return { started: n("STARTED"), choices: n("CHOSE"), handedOff: n("HANDOFF"), invalid: n("INVALID") };
}

export async function listMenuBots() {
  const since = new Date(Date.now() - 30 * DAY);
  const [bots, counts] = await Promise.all([
    prisma.menuBot.findMany({ orderBy: { createdAt: "desc" }, take: 100, select: { id: true, name: true, status: true, keywords: true, startOnFirstMessage: true, onWhatsAppPersonal: true, onWhatsAppGroups: true, channels: true, updatedAt: true } }),
    prisma.menuEvent.groupBy({ by: ["botId", "kind"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
  ]);
  return bots.map((b) => ({ ...b, channels: b.channels as MenuBotChannel[], updatedAt: b.updatedAt.toISOString(), stats: tally(counts.filter((c) => c.botId === b.id)) }));
}

export async function loadMenuBot(id: string) {
  const since = new Date(Date.now() - 30 * DAY);
  const bot = await prisma.menuBot.findFirst({ where: { id } });
  if (!bot) return null;
  const tree: MenuTree | null = readMenuTree(bot.tree);
  if (!tree) return null;
  const [counts, options, running] = await Promise.all([
    prisma.menuEvent.groupBy({ by: ["kind"], where: { botId: id, createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.menuEvent.groupBy({ by: ["optionLabel"], where: { botId: id, kind: "CHOSE", createdAt: { gte: since } }, _count: { _all: true }, orderBy: { _count: { optionLabel: "desc" } }, take: 8 }),
    prisma.menuSession.count({ where: { botId: id, status: "ACTIVE", expiresAt: { gt: new Date() } } }),
  ]);
  return {
    id: bot.id,
    name: bot.name,
    status: bot.status,
    tree,
    keywords: bot.keywords,
    startOnFirstMessage: bot.startOnFirstMessage,
    onWhatsAppPersonal: bot.onWhatsAppPersonal,
    onWhatsAppGroups: bot.onWhatsAppGroups,
    channels: bot.channels as MenuBotChannel[],
    invalidText: bot.invalidText,
    handoffText: bot.handoffText,
    backLabel: bot.backLabel,
    homeLabel: bot.homeLabel,
    maxInvalid: bot.maxInvalid,
    sessionMinutes: bot.sessionMinutes,
    quietMinutes: bot.quietMinutes,
    stats: { ...tally(counts), running },
    topOptions: options.map((o) => ({ label: o.optionLabel ?? "", count: o._count._all })),
  };
}
export type MenuBotDetail = NonNullable<Awaited<ReturnType<typeof loadMenuBot>>>;
