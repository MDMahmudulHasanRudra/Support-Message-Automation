import { avatarsGloballyDisabled } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeDisabledFeatures } from "@/server/projectFeatures";

/**
 * WhatsApp profile pictures in the dashboard (WHATSAPP_AVATARS.md). Read only: pictures the worker
 * saved from incoming messages, for the URL's project, never another's (the scoped client). With the
 * project's WHATSAPP_AVATARS feature off, or the server's WHATSAPP_AVATARS_DISABLED set, nothing is
 * read and nothing is served.
 */
export async function avatarsEnabled(): Promise<boolean> {
  if (avatarsGloballyDisabled(process.env)) return false;
  return !(await activeDisabledFeatures()).has("WHATSAPP_AVATARS");
}

/**
 * Project-relative avatar paths for the given chats or people of ONE account, keyed by WhatsApp id.
 * A chat with no stored picture is simply absent — the caller shows the coloured initials.
 */
export async function picturePaths(accountId: string, jids: readonly string[]): Promise<Record<string, string>> {
  const wanted = [...new Set(jids.filter(Boolean))];
  if (wanted.length === 0 || !(await avatarsEnabled())) return {};
  const rows = await prisma.whatsAppPicture.findMany({
    where: { accountId, jid: { in: wanted }, storedAt: { not: null } },
    select: { id: true, jid: true, storedAt: true },
  });
  return Object.fromEntries(rows.map((r) => [r.jid, `/api/whatsapp/avatar/${encodeURIComponent(r.id)}?v=${r.storedAt!.getTime()}`]));
}
