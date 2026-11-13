import { pageAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { formatDate } from "@/lib/date";
import { Card, PageHeader, ViewOnlyNotice } from "@/components/ui";
import { ContactSettingsForm } from "./ContactSettingsForm";

export const metadata = { title: "Contacts" };

/** A cursor this close to now is keeping up with new messages, not working through history. */
const CAUGHT_UP_MS = 5 * 60_000;

/**
 * How far the collector has read, from its cursors alone: a cursor near now is caught up, and an older one is behind only
 * if something was stored after it. Each check is one bounded lookup, never a count.
 */
async function scanProgress(s: { whatsappCursorAt: Date | null; channelCursorAt: Date | null }): Promise<string> {
  if (!s.whatsappCursorAt) return "Past conversations: the scan starts within a minute.";
  const recent = new Date(Date.now() - CAUGHT_UP_MS);
  const [whatsappBehind, channelsBehind] = await Promise.all([
    s.whatsappCursorAt > recent ? null : prisma.message.findFirst({ where: { direction: "INCOMING", createdAt: { gt: s.whatsappCursorAt } }, select: { id: true } }),
    !s.channelCursorAt || s.channelCursorAt > recent ? null : prisma.channelConversation.findFirst({ where: { updatedAt: { gt: s.channelCursorAt } }, select: { id: true } }),
  ]);
  if (whatsappBehind) return `Past conversations: scanning, read up to ${formatDate(s.whatsappCursorAt)}.`;
  if (channelsBehind || !s.channelCursorAt) return "Past conversations: scanning the other channels.";
  return "All conversations read. New messages are read within a minute.";
}

/** Settings → Contacts (CONTACTS.md): whether contacts are collected from chats without anyone pressing a button. */
export default async function ContactSettingsPage() {
  const { canManage } = await pageAccess("settings.view", "settings.edit", "CONTACTS");
  const [settings, ai] = await Promise.all([
    prisma.contactSettings.findFirst({ select: { aiCollectionEnabled: true, autoCreateFromChats: true, whatsappCursorAt: true, channelCursorAt: true } }),
    prisma.aiSettings.findUnique({ where: { id: "global" }, select: { aiEngineEnabled: true } }),
  ]);
  // No settings row yet means the defaults: collecting from every conversation.
  const auto = settings?.autoCreateFromChats ?? true;
  const on = auto || (settings?.aiCollectionEnabled ?? false);
  const progress = on ? await scanProgress(settings ?? { whatsappCursorAt: null, channelCursorAt: null }) : null;
  return (
    <div className="max-w-2xl">
      <PageHeader title="Contacts" description="Collect customers' details from chats by themselves. Every conversation is read, past ones included, and numbers, emails and links customers wrote are saved to their contact." />
      {!canManage ? <ViewOnlyNotice /> : null}
      <Card>
        <ContactSettingsForm ai={settings?.aiCollectionEnabled ?? false} auto={auto} aiEngineOn={ai?.aiEngineEnabled ?? false} canManage={canManage} progress={progress} />
      </Card>
    </div>
  );
}
