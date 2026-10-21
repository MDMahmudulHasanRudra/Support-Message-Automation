import { Alert, Card, PageHeader, SectionHeader } from "@/components/ui";
import { requireMainAdminPage } from "@/server/mainAdmin";
import { hostRoutingForcedOff, requestHostname } from "@/server/hostScope";
import { getDomainSettings, listAllDomains } from "@/server/saasAdmin";
import { DomainManager } from "../DomainManager";
import { DomainSettingsForm } from "./DomainSettingsForm";

export const metadata = { title: "Domains" };

const CADDY_SNIPPET = `{
\ton_demand_tls {
\t\task http://127.0.0.1:8668/api/platform/tls-allowed
\t}
}

# Existing site: keep it exactly as it is.
zoventio.udboy.com {
\tencode gzip
\treverse_proxy 127.0.0.1:8668
}

# Every customer address, over HTTPS. A certificate is requested only for a
# hostname the app says yes to (an address you verified, or an admin address).
https:// {
\ttls {
\t\ton_demand
\t}
\tencode gzip
\treverse_proxy 127.0.0.1:8668
}

# Plain HTTP for every other hostname, so a new address can be verified
# before it has a certificate.
http:// {
\treverse_proxy 127.0.0.1:8668
}`;

export default async function DomainsPage() {
  const { canManage } = await requireMainAdminPage();
  const [settings, domains, here] = await Promise.all([getDomainSettings(), listAllDomains(), requestHostname()]);

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="Domains"
        description="Which hostnames open the Main Admin Portal, which open each customer's workspace, and where their DNS must point. One deployment serves every address."
      />

      {hostRoutingForcedOff() ? (
        <Alert tone="warning" title="Hostname routing is forced off on the server">
          SAAS_HOST_ROUTING_DISABLED is set, so every address behaves as it did before routing existed, whatever the switch below says. Remove it from the
          server&apos;s .env and recreate the app container when the problem is fixed.
        </Alert>
      ) : null}

      <Card>
        <SectionHeader title="Platform settings" />
        <DomainSettingsForm canManage={canManage} settings={settings} currentHost={here} />
      </Card>

      <Card>
        <SectionHeader title="Customer addresses" description="Add an address from the customer's page. Check it here or there." />
        <DomainManager domains={domains} canManage={canManage} rootDomain={settings.rootDomain} showCustomer />
      </Card>

      <Card>
        <SectionHeader
          title="Server setup (one time)"
          description="The reverse proxy (Caddy) forwards every hostname to this application and gets each certificate on demand. After this one change, adding a customer never needs a server change."
        />
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>Back up the current configuration: <code className="font-mono text-xs">sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak</code></li>
          <li>Replace <code className="font-mono text-xs">/etc/caddy/Caddyfile</code> with the configuration below (the existing site block is kept unchanged).</li>
          <li>
            Check and reload: <code className="font-mono text-xs">sudo caddy validate --config /etc/caddy/Caddyfile &amp;&amp; sudo systemctl reload caddy</code>
          </li>
          <li>Create the admin address&apos;s DNS record (an A record pointing to the server&apos;s public IP).</li>
        </ol>
        <pre className="mt-4 overflow-x-auto rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-4 font-mono text-xs leading-relaxed">{CADDY_SNIPPET}</pre>
        <p className="mt-3 text-xs text-[color:var(--color-muted-foreground)]">
          Optional later: a wildcard DNS record and certificate (<code className="font-mono">*.{settings.rootDomain ?? "example.com"}</code>) needs your DNS
          provider&apos;s API token and a Caddy build with that provider&apos;s module. Individual records, as above, always work.
        </p>
      </Card>
    </div>
  );
}
