import { requireAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { publicOrigin } from "@/server/google/oauth";
import { HelpButton, HelpSection, PageHeader } from "@/components/ui";
import { ApiKeysPanel, WebhooksPanel } from "./ApiSettings";

export const metadata = { title: "API & Webhooks" };

export default async function ApiSettingsPage() {
  await requireAccess("api.manage");
  const [keys, endpoints] = await Promise.all([
    prisma.apiKey.findMany({ orderBy: [{ revokedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }], take: 100 }),
    prisma.webhookEndpoint.findMany({ orderBy: { createdAt: "asc" }, include: { deliveries: { orderBy: { createdAt: "desc" }, take: 15 } } }),
  ]);
  const origin = publicOrigin();
  return (
    <div className="space-y-6">
      <PageHeader
        title="API & Webhooks"
        description="Connect your own systems, n8n, Zapier or Make: read products and orders, create leads, and receive signed events when things change."
        actions={
          <HelpButton moduleTitle="API & Webhooks">
            <HelpSection title="Calling the API">
              <p>
                Send the key as <code>Authorization: Bearer ga_…</code>. Endpoints: GET /products, GET /orders, GET /orders/&lt;number&gt;, GET
                /shipments?order=&lt;number&gt;, POST /leads. At most 120 requests a minute per key. A module that is switched off answers 404.
              </p>
            </HelpSection>
            <HelpSection title="Checking a webhook's signature">
              <p>
                Take <code>t</code> and <code>v1</code> from X-GetAssist-Signature, compute HMAC-SHA256 of “t.” followed by the raw body with your
                endpoint secret, compare it to v1, and refuse a <code>t</code> older than five minutes.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />
      <ApiKeysPanel
        apiBase={origin ? `${origin}/api/public/v1` : null}
        keys={keys.map((k) => ({
          id: k.id,
          name: k.name,
          prefix: k.prefix,
          scopes: k.scopes,
          createdByUsername: k.createdByUsername,
          createdAt: k.createdAt.toISOString(),
          lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
          expiresAt: k.expiresAt?.toISOString() ?? null,
          revokedAt: k.revokedAt?.toISOString() ?? null,
        }))}
      />
      <WebhooksPanel
        endpoints={endpoints.map((e) => ({
          id: e.id,
          url: e.url,
          description: e.description,
          events: e.events,
          isActive: e.isActive,
          deliveries: e.deliveries.map((d) => ({
            id: d.id,
            event: d.event,
            status: d.status,
            attempts: d.attempts,
            lastStatusCode: d.lastStatusCode,
            lastError: d.lastError,
            createdAt: d.createdAt.toISOString(),
            deliveredAt: d.deliveredAt?.toISOString() ?? null,
          })),
        }))}
      />
    </div>
  );
}
