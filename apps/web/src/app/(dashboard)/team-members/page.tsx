import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Button, Card, Field, Input, PageHeader, SectionHeader } from "@/components/ui";
import { createTeamMember } from "@/server/actions/teamMembers";
import { TeamMembersTable, type TeamMemberRow } from "./TeamMembersTable";

export default async function TeamMembersPage() {
  await requireSession();
  const members: TeamMemberRow[] = await prisma.internalTeamMember.findMany({ orderBy: { createdAt: "desc" } });

  return (
    <div>
      <PageHeader
        title="Internal Team Members"
        description="Messages from active team members are ignored by client automation by default."
      />

      <Card className="mb-6">
        <SectionHeader title="Add Team Member" />
        <form action={createTeamMember} className="grid grid-cols-1 gap-3 md:grid-cols-5">
          <Field label="Name">
            <Input name="name" placeholder="Name" required />
          </Field>
          <Field label="Phone">
            <Input name="phoneNumber" placeholder="+8801XXXXXXXXX" required />
          </Field>
          <Field label="Role">
            <Input name="role" placeholder="Role" required />
          </Field>
          <Field label="Department">
            <Input name="department" placeholder="Optional" />
          </Field>
          <div className="flex items-end">
            <Button type="submit" className="w-full">
              Add
            </Button>
          </div>
        </form>
      </Card>

      <TeamMembersTable members={members} />
    </div>
  );
}
