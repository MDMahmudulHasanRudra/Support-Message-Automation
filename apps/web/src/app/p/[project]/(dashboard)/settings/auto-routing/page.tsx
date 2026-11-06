import { pageAccess } from "@/server/authorize";
import { Alert, Badge, Card, HelpButton, HelpSection, PageHeader, Table, Td, Th, ViewOnlyNotice } from "@/components/ui";
import { prisma } from "@/server/db";
import { mentionablePeople } from "@/server/inboxWorkspace";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { loadRoutingPanel, loadRoutingSettingsView } from "@/server/autoRouting";
import { ROUTING_CHANNEL_LABELS, ROUTING_REASON_LABELS, type DutyNow, type RoutingIneligibleReason } from "@support-automation/shared";
import { AutoRoutingForm } from "./AutoRoutingForm";

const DUTY_LABELS: Record<DutyNow, string> = {
  ON_DUTY: "On duty",
  OFF_SHIFT: "Outside their shift",
  OFF: "Day off",
  ON_LEAVE: "On leave",
  MARKED_ABSENT: "Marked absent",
  NOT_SCHEDULED: "Not on the roster today",
};

/**
 * Settings → Support → Automatic routing (AUTO_ROUTING.md; features AUTO_ROUTING + UNIFIED_INBOX_V3). Who new
 * conversations go to and how, plus a read-only panel of who could take one right now and why the others
 * could not.
 */
export default async function AutoRoutingSettingsPage() {
  const { session, canManage } = await pageAccess("settings.view", "settings.edit", "AUTO_ROUTING");
  const disabled = await activeDisabledFeatures();
  const [settings, panel, teams, people] = await Promise.all([
    loadRoutingSettingsView(),
    loadRoutingPanel(),
    prisma.team.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    mentionablePeople(session),
  ]);
  const unrouted = settings.lastUnroutedReasons
    ? Object.entries(settings.lastUnroutedReasons)
        .map(([reason, count]) => `${ROUTING_REASON_LABELS[reason as RoutingIneligibleReason] ?? reason}: ${count}`)
        .join(" · ")
    : null;

  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader
        title="Automatic routing"
        description="Give each new customer conversation to one person automatically."
        actions={
          <HelpButton moduleTitle="Automatic routing">
            <HelpSection title="When it routes">
              <p>
                When a customer writes in a conversation that is Open and has nobody, and once a minute for anything still waiting. Only
                conversations a customer wrote in after routing was switched on, within the last day. A conversation that already has
                somebody is never moved; a WhatsApp group with an owner is never routed.
              </p>
            </HelpSection>
            <HelpSection title="Who can be given one">
              <p>
                People in the chosen Teams (at that moment) and the people chosen by name — only if their login is active, they have access
                to this project and their role can reply there, they are not on approved leave, they hold fewer open conversations than the
                limit, and, when you ask for it, they are on duty by the roster and were seen in the dashboard recently. If nobody qualifies
                the conversation stays unassigned; routing never falls back to somebody who did not.
              </p>
            </HelpSection>
            <HelpSection title="What it never does">
              <p>It never sends a message, and never changes a conversation&apos;s status, automation or AI. People can still reassign by hand.</p>
            </HelpSection>
          </HelpButton>
        }
      />
      {disabled.has("UNIFIED_INBOX_V3") ? <Alert tone="warning" title="Inbox V3 is off">Automatic routing assigns through Inbox V3, so it does nothing until Inbox V3 is switched on for this project.</Alert> : null}
      {!canManage ? <ViewOnlyNotice /> : null}
      <Card>
        <AutoRoutingForm initial={settings} teams={teams} people={people.map((p) => ({ id: p.id, name: p.name }))} canManage={canManage} />
      </Card>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Routing now</h2>
        <p className="text-xs text-[color:var(--color-muted-foreground)]">
          Who in the pool could be given a conversation at this moment, and why the others could not. Read-only.
          {unrouted && settings.lastUnroutedAt ? ` Last time nobody could take one (${new Date(settings.lastUnroutedAt).toLocaleString("en-GB", { timeZone: "Asia/Dhaka" })}): ${unrouted}.` : ""}
        </p>
        {panel.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">Nobody is in the pool yet. Choose Teams or people above.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Person</Th>
                <Th>Can take one now</Th>
                <Th>Open now</Th>
                <Th>Roster</Th>
              </tr>
            </thead>
            <tbody>
              {panel.map((row) => (
                <tr key={row.userId}>
                  <Td>{row.name}</Td>
                  <Td>
                    {row.eligible ? (
                      <Badge color="green">{row.onlyFor ? `Yes — ${row.onlyFor.map((k) => (k === "WHATSAPP_GROUP" ? "WhatsApp groups" : ROUTING_CHANNEL_LABELS[k])).join(", ")} only` : "Yes"}</Badge>
                    ) : (
                      <Badge color={row.reason === "AT_CAPACITY" ? "yellow" : "gray"}>{row.reason ? ROUTING_REASON_LABELS[row.reason] : "No"}</Badge>
                    )}
                  </Td>
                  <Td>{row.openCount}</Td>
                  <Td>{row.duty ? DUTY_LABELS[row.duty] : "Not linked to a team member"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
