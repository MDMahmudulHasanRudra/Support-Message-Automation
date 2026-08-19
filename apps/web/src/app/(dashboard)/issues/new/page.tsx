import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Button, Card, Field, Input, PageHeader, SectionHeader, Select } from "@/components/ui";
import { createSupportIssue } from "@/server/actions/issues";

export default async function NewIssuePage() {
  await requireSession();
  const [groups, channels] = await Promise.all([
    prisma.whatsAppGroup.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.teamsChannel.findMany({ orderBy: { name: "asc" }, include: { team: true } }),
  ]);

  return (
    <div>
      <PageHeader title="Create Issue" />
      <form action={createSupportIssue} className="space-y-4">
        <Card>
          <SectionHeader title="Customer Conversation" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="WhatsApp Group" required>
              <Select name="groupId" required>
                <option value="">Select a group…</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Customer Phone Number" required hint="Where the resolution notification will be sent.">
              <Input name="clientPhone" placeholder="+8801700000000" required />
            </Field>
            <Field label="Title" hint="Optional — a short label for this issue.">
              <Input name="title" placeholder="e.g. Payment gateway timeout" />
            </Field>
          </div>
        </Card>

        <Card>
          <SectionHeader title="Teams Link" description="Optional now — you can link it later once a developer starts a thread." />
          {channels.length === 0 ? (
            <p className="text-sm text-[color:var(--color-muted-foreground)]">
              No Teams channels synced yet — connect Microsoft Teams and run a sync first, or leave
              this blank and link it later.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Teams Channel">
                <Select name="teamsChannelId" defaultValue="">
                  <option value="">Not linked yet</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.team.name} / {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Thread ID" hint="The Teams message id of the thread root, if known.">
                <Input name="teamsThreadExternalId" placeholder="Optional" />
              </Field>
            </div>
          )}
        </Card>

        <Button type="submit">Create Issue</Button>
      </form>
    </div>
  );
}
