import { ISO_CURRENCY_CODES, currencyMinorUnits } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { loadClientConfiguration } from "@/server/clientConfiguration";
import { PageHeader, ViewOnlyNotice } from "@/components/ui";
import { countryOptions, suggestedCurrency } from "@/lib/clientPhone";
import { currencyName, languageCodeForCountry, languageName, languageOptions } from "@/lib/clientLocale";
import { ConfigurationCenter } from "./ConfigurationCenter";

export const metadata = { title: "Client Lists" };

/**
 * Settings → Client Lists (CLIENT_CONFIGURATION.md): the Client Configuration Center. The project's own tags,
 * categories, business types and service plans, which currencies it offers, and its per-country choices. Offered
 * on Add / Edit Client and matched on import; a list never takes a value away from a client.
 */
export default async function ClientConfigurationPage() {
  const { canManage } = await pageAccess("clients.manage_settings", "clients.manage_settings");
  const config = await loadClientConfiguration();
  return (
    <div className="space-y-5">
      <PageHeader
        title="Client Lists"
        description="The choices your team picks from on Add / Edit Client and that imports match to — so nobody types the same tag, category or plan twice. Changing a list never removes a value from a client."
      />
      {canManage ? null : <ViewOnlyNotice />}
      <ConfigurationCenter
        canEdit={canManage}
        config={config}
        currencies={ISO_CURRENCY_CODES.map((code) => ({ code, name: currencyName(code), decimals: currencyMinorUnits(code) }))}
        countries={countryOptions().map((c) => ({
          code: c.code,
          name: c.name,
          callingCode: c.callingCode,
          currency: suggestedCurrency(c.code),
          language: languageName(languageCodeForCountry(c.code)),
        }))}
        languages={languageOptions().map((l) => l.name)}
      />
    </div>
  );
}
