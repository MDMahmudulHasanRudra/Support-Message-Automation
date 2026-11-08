import { pageAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { Card, PageHeader, ViewOnlyNotice } from "@/components/ui";
import { ContactSettingsForm } from "./ContactSettingsForm";

export const metadata = { title: "Contacts" };

/** Settings → Contacts (CONTACTS.md): whether contacts are collected from chats without anyone pressing a button. */
export default async function ContactSettingsPage() {
  const { canManage } = await pageAccess("settings.view", "settings.edit", "CONTACTS");
  const [settings, ai] = await Promise.all([prisma.contactSettings.findFirst({ select: { aiCollectionEnabled: true, autoCreateFromChats: true } }), prisma.aiSettings.findUnique({ where: { id: "global" }, select: { aiEngineEnabled: true } })]);
  return (
    <div className="max-w-2xl">
      <PageHeader title="Contacts" description="Collect customers' details from chats by themselves. Both switches start from now and never read older messages." />
      {!canManage ? <ViewOnlyNotice /> : null}
      <Card>
        <ContactSettingsForm ai={settings?.aiCollectionEnabled ?? false} auto={settings?.autoCreateFromChats ?? false} aiEngineOn={ai?.aiEngineEnabled ?? false} canManage={canManage} />
      </Card>
    </div>
  );
}
