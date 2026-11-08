import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { PageHeader } from "@/components/ui";
import { ContactImport } from "./ContactImport";

export const metadata = { title: "Import contacts" };

/** Bring people in from a file or the client list (CONTACTS.md). */
export default async function ContactImportPage() {
  const session = await requireAccess("contacts.import", "CONTACTS");
  const disabled = await activeDisabledFeatures();
  const canUseClients = !disabled.has("CLIENT_CENTER") && (await hasPermission(session, "clients.view"));
  return (
    <div className="max-w-4xl">
      <PageHeader title="Import contacts" description="Upload a list or copy your client list. Numbers already saved are never added twice." />
      <ContactImport canUseClients={canUseClients} />
    </div>
  );
}
