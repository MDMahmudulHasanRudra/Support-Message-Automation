import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Button, Card, EmptyState, HelpButton, HelpSection, PageHeader, SectionHeader, Switch } from "@/components/ui";
import { updateTeamsAutomationScope } from "@/server/actions/teamsIntegration";

export default async function ManageTeamsPage() {
  await requireSession();
  const teams = await prisma.teamsTeam.findMany({ orderBy: { name: "asc" }, include: { channels: { orderBy: { name: "asc" } } } });

  const allTeamIds = teams.map((t) => t.id).join(",");
  const allChannelIds = teams.flatMap((t) => t.channels.map((c) => c.id)).join(",");

  return (
    <div>
      <PageHeader
        title="Manage Teams & Channels"
        description="Choose which Teams and channels are used for support automation. Everything discovered is included by default."
        actions={
          <HelpButton moduleTitle="Manage Teams & Channels">
            <HelpSection title="What this controls">
              <p>
                Every Team and channel the connected Microsoft account can see is always discovered
                automatically — nothing here needs a Team ID or channel ID. Turning a Team or
                channel off here just stops its messages from being synced for automation; an Issue
                explicitly linked to a channel is always synced regardless of this setting.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      {teams.length === 0 ? (
        <EmptyState>
          No Teams discovered yet — connect Microsoft Teams and wait for the first sync, or click
          Sync Now on the Connection page.
        </EmptyState>
      ) : (
        <form action={updateTeamsAutomationScope} className="space-y-4">
          <input type="hidden" name="allTeamIds" value={allTeamIds} />
          <input type="hidden" name="allChannelIds" value={allChannelIds} />

          {teams.map((team) => (
            <Card key={team.id}>
              <div className="flex items-center justify-between gap-4">
                <SectionHeader title={team.name} />
                <label className="flex shrink-0 items-center gap-2 text-sm">
                  <Switch name={`team_${team.id}`} defaultChecked={team.isEnabledForAutomation} />
                  Used for automation
                </label>
              </div>
              {team.channels.length === 0 ? (
                <p className="text-sm text-[color:var(--color-muted-foreground)]">No channels discovered yet.</p>
              ) : (
                <div className="space-y-2">
                  {team.channels.map((channel) => (
                    <label key={channel.id} className="flex items-center justify-between gap-4 rounded-[var(--radius-sm)] border border-[var(--color-border)] px-3 py-2 text-sm">
                      <span>{channel.name}</span>
                      <Switch name={`channel_${channel.id}`} defaultChecked={channel.isEnabledForAutomation} />
                    </label>
                  ))}
                </div>
              )}
            </Card>
          ))}

          <Button type="submit">Save</Button>
        </form>
      )}
    </div>
  );
}
