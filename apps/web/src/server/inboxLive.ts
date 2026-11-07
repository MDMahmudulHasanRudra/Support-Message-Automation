import { globalPrisma } from "@/server/db";

/**
 * Tells open inboxes that something changed, and nothing about what (AGENT_APP.md). One check per project
 * with somebody watching, whatever the number of viewers, in place of every viewer re-rendering the whole
 * inbox every four seconds. The browser then refreshes through the ordinary page, with its ordinary checks.
 */
const CHECK_MS = 1500;

type Listener = () => void;
interface Hub {
  listeners: Set<Listener>;
  token: string | null;
  timer: ReturnType<typeof setInterval>;
  checking: boolean;
}

const hubs = new Map<string, Hub>();

/** The newest stored message, channel message and conversation event of one project. */
export async function readInboxToken(projectId: string): Promise<string> {
  const rows = await globalPrisma.$queryRaw<Array<{ wa: Date | null; ch: Date | null; ev: Date | null }>>`
    SELECT
      (SELECT max(newest."createdAt")
         FROM "WhatsAppAccount" a
         CROSS JOIN LATERAL (
           SELECT m."createdAt" FROM "Message" m
           WHERE m."accountId" = a."id" AND m."projectId" = ${projectId}
           ORDER BY m."timestampWa" DESC LIMIT 1
         ) newest
         WHERE a."projectId" = ${projectId}) AS wa,
      (SELECT c."lastMessageAt" FROM "ChannelConversation" c
         WHERE c."projectId" = ${projectId} AND c."lastMessageAt" IS NOT NULL
         ORDER BY c."lastMessageAt" DESC LIMIT 1) AS ch,
      (SELECT e."createdAt" FROM "ConversationEvent" e
         WHERE e."projectId" = ${projectId}
         ORDER BY e."createdAt" DESC LIMIT 1) AS ev
  `;
  const row = rows[0];
  return [row?.wa, row?.ch, row?.ev].map((d) => d?.getTime() ?? 0).join("|");
}

async function check(projectId: string, hub: Hub): Promise<void> {
  if (hub.checking) return;
  hub.checking = true;
  try {
    const token = await readInboxToken(projectId);
    const changed = hub.token !== null && hub.token !== token;
    hub.token = token;
    if (changed) for (const listener of hub.listeners) listener();
  } catch (err) {
    console.error("[inbox-live] check failed", (err as Error).name);
  } finally {
    hub.checking = false;
  }
}

/** Start hearing about one project's changes. The returned function stops it; the last listener stops the checks. */
export function subscribeInboxChanges(projectId: string, listener: Listener): () => void {
  let hub = hubs.get(projectId);
  if (!hub) {
    const created: Hub = { listeners: new Set(), token: null, checking: false, timer: setInterval(() => void check(projectId, created), CHECK_MS) };
    created.timer.unref?.();
    hubs.set(projectId, created);
    void check(projectId, created);
    hub = created;
  }
  hub.listeners.add(listener);
  const current = hub;
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      clearInterval(current.timer);
      hubs.delete(projectId);
    }
  };
}
