import { PlugZap } from "lucide-react";
import { requireSession } from "@/server/auth";
import { integrationsFor, INTEGRATION_CATEGORIES } from "@/server/integrationsDirectory";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { IntegrationsDirectory } from "./IntegrationsDirectory";

export const metadata = { title: "Integrations" };

/**
 * Every integration this project can have, in one place, each with its real state and one button: Connect,
 * Fix or Manage. A card appears only when the person could open that integration's own page (same key,
 * module and page-access rules as the sidebar); the page that opens keeps all its own checks.
 */
export default async function IntegrationsPage() {
  const session = await requireSession();
  const cards = await integrationsFor(session);
  return (
    <div>
      <PageHeader
        title="Integrations"
        description="Connect the services this project works with. Each one takes a few steps, and its card shows whether it is working."
      />
      {cards.length === 0 ? (
        <Card>
          <EmptyState icon={<PlugZap className="size-5" aria-hidden />}>
            There are no integrations you can set up in this project. Ask an administrator if you need one.
          </EmptyState>
        </Card>
      ) : (
        <IntegrationsDirectory cards={cards} categories={[...INTEGRATION_CATEGORIES]} />
      )}
    </div>
  );
}
