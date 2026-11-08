import { pageAccess } from "@/server/authorize";
import { Card, HelpButton, HelpSection, PageHeader, ViewOnlyNotice } from "@/components/ui";
import { loadTicketConfig } from "@/server/tickets";
import { TicketSettingsForm } from "./TicketSettingsForm";

export const metadata = { title: "Tickets" };

/** Settings → Support → Tickets (TICKETS.md): how long each priority gets, and the categories people choose from. */
export default async function TicketSettingsPage() {
  const { canManage } = await pageAccess("settings.view", "settings.edit");
  const config = await loadTicketConfig();
  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Tickets"
        description="How long each priority gets, and the categories your team chooses from."
        actions={
          <HelpButton moduleTitle="Ticket settings">
            <HelpSection title="Targets">
              <p>
                A new ticket is due this many hours after it is opened, counted around the clock. Changing a target applies to new
                tickets; tickets already open keep their due time unless somebody changes their priority.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />
      {!canManage ? <ViewOnlyNotice /> : null}
      <Card>
        <TicketSettingsForm config={config} canManage={canManage} />
      </Card>
    </div>
  );
}
