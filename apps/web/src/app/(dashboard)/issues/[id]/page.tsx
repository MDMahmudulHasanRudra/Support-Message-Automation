import { notFound } from "next/navigation";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { formatDateTime } from "@/lib/date";
import { Badge, Button, Card, Field, ModuleCardRow, PageHeader, SectionHeader, Select, Table, Td, Th, Input } from "@/components/ui";
import { linkSupportIssueToTeams } from "@/server/actions/issues";
import { IssueActions } from "./IssueActions";
import { IgnoreEventButton } from "./IgnoreEventButton";

const STATUS_COLOR: Record<string, "green" | "gray" | "blue" | "yellow" | "red"> = {
  OPEN: "gray",
  IN_PROGRESS: "blue",
  WAITING_DEVELOPER: "yellow",
  RESOLUTION_DETECTED: "yellow",
  WAITING_CUSTOMER_CHECK: "yellow",
  RESOLVED: "green",
  CLOSED: "gray",
};

const OUTCOME_COLOR: Record<string, "green" | "gray" | "yellow"> = {
  NOTIFIED: "green",
  SKIPPED_MANUALLY_IGNORED: "gray",
};

export default async function IssueDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;

  const issue = await prisma.supportIssue.findUnique({
    where: { id },
    include: {
      group: true,
      supportExecutive: true,
      teamsChannel: { include: { team: true } },
      resolutionEvents: { orderBy: { detectedAt: "desc" }, include: { teamsMessage: true, matchedRule: true } },
    },
  });
  if (!issue) notFound();

  const channels = await prisma.teamsChannel.findMany({ orderBy: { name: "asc" }, include: { team: true } });
  const linkWithId = linkSupportIssueToTeams.bind(null, issue.id);

  return (
    <div>
      <PageHeader
        title={issue.title ?? `Issue ${issue.id.slice(-6)}`}
        description={`${issue.clientPhone} · ${issue.group.name}`}
        actions={<IssueActions id={issue.id} status={issue.status} />}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <SectionHeader title="Details" />
          <div className="space-y-1.5">
            <ModuleCardRow label="Status">
              <Badge color={STATUS_COLOR[issue.status] ?? "gray"} dot>
                {issue.status.replace(/_/g, " ")}
              </Badge>
            </ModuleCardRow>
            <ModuleCardRow label="Customer">{issue.clientPhone}</ModuleCardRow>
            <ModuleCardRow label="WhatsApp Group">{issue.group.name}</ModuleCardRow>
            <ModuleCardRow label="Support Executive">{issue.supportExecutive?.name ?? "Unassigned"}</ModuleCardRow>
            <ModuleCardRow label="Created">{formatDateTime(issue.createdAt)}</ModuleCardRow>
            {issue.resolvedAt ? <ModuleCardRow label="Resolved">{formatDateTime(issue.resolvedAt)}</ModuleCardRow> : null}
          </div>
        </Card>

        <Card>
          <SectionHeader title="Teams Link" description="Which channel/thread a developer's resolution reply is matched against." />
          {issue.teamsChannel ? (
            <div className="mb-4 space-y-1.5">
              <ModuleCardRow label="Team">{issue.teamsChannel.team.name}</ModuleCardRow>
              <ModuleCardRow label="Channel">{issue.teamsChannel.name}</ModuleCardRow>
              <ModuleCardRow label="Thread">{issue.teamsThreadExternalId ?? "Entire channel"}</ModuleCardRow>
            </div>
          ) : (
            <p className="mb-4 text-sm text-[color:var(--color-muted-foreground)]">Not linked to a Teams channel yet.</p>
          )}
          <form action={linkWithId} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Teams Channel">
              <Select name="teamsChannelId" defaultValue={issue.teamsChannelId ?? ""}>
                <option value="">Not linked</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.team.name} / {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Thread ID">
              <Input name="teamsThreadExternalId" defaultValue={issue.teamsThreadExternalId ?? ""} placeholder="Optional" />
            </Field>
            <div className="sm:col-span-2">
              <Button type="submit" variant="secondary" size="sm">
                Save Link
              </Button>
            </div>
          </form>
        </Card>
      </div>

      <div className="mt-6">
        <SectionHeader title="Resolution Events" description="Every Teams message evaluated against this issue's active resolution rules." />
        {issue.resolutionEvents.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">No resolution events yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Detected</Th>
                <Th>Matched Keyword</Th>
                <Th>Teams Message</Th>
                <Th>Outcome</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {issue.resolutionEvents.map((event) => (
                <tr key={event.id}>
                  <Td>{formatDateTime(event.detectedAt)}</Td>
                  <Td>{event.matchedKeyword ?? "—"}</Td>
                  <Td className="max-w-sm truncate">{event.teamsMessage.body}</Td>
                  <Td>
                    <Badge color={OUTCOME_COLOR[event.outcome] ?? "yellow"} dot>
                      {event.outcome.replace(/_/g, " ")}
                    </Badge>
                  </Td>
                  <Td>
                    {event.outcome === "NOTIFIED" ? <IgnoreEventButton eventId={event.id} /> : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </div>
  );
}
