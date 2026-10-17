import { pageAccess } from "@/server/authorize";
import { getClientModuleSettings } from "@/server/clientModule";
import { Card, PageHeader, ViewOnlyNotice } from "@/components/ui";
import { CLIENT_REQUIRABLE_FIELDS, CLIENT_SUB_MODULES, CLIENT_SUB_MODULE_INFO } from "@support-automation/shared";
import { countryOptions } from "@/lib/clientPhone";
import { ClientSettingsForm } from "./ClientSettingsForm";

/**
 * Settings → Client Module (CLIENTS_V3.md §7): the project's own choices inside Client Management —
 * which sub-modules it uses, which fields are required, the renewal window and the default country for
 * numbers typed without a code. All Clients and Import Clients are always on while the module is.
 */
export default async function ClientSettingsPage() {
  const { canManage } = await pageAccess("clients.manage_settings", "clients.manage_settings");
  const settings = await getClientModuleSettings();
  return (
    <div className="space-y-5">
      <PageHeader title="Client Module" description="What this project uses inside Client Management, and which details staff must fill in. Applies to everyone in the project at once." />
      {canManage ? null : <ViewOnlyNotice />}
      <Card className="max-w-3xl p-6">
        <ClientSettingsForm
          initial={settings}
          canEdit={canManage}
          modules={CLIENT_SUB_MODULES.map((m) => ({ key: m, ...CLIENT_SUB_MODULE_INFO[m] }))}
          fields={CLIENT_REQUIRABLE_FIELDS.map((f) => ({ key: f.key, label: f.label }))}
          countries={countryOptions().map((c) => ({ code: c.code, name: c.name }))}
        />
      </Card>
    </div>
  );
}
