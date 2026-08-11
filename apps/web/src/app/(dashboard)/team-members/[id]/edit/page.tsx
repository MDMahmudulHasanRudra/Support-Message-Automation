import { notFound } from "next/navigation";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Button, Card, Field, Input, PageHeader } from "@/components/ui";
import { updateTeamMember } from "@/server/actions/teamMembers";

export default async function EditTeamMemberPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  const member = await prisma.internalTeamMember.findUnique({ where: { id } });
  if (!member) notFound();

  const updateWithId = updateTeamMember.bind(null, member.id);

  return (
    <div>
      <PageHeader title={`Edit ${member.name}`} />
      <Card className="max-w-lg">
        <form action={updateWithId} className="space-y-4">
          <Field label="Name" required>
            <Input name="name" defaultValue={member.name} required />
          </Field>
          <Field label="Phone Number" required>
            <Input name="phoneNumber" defaultValue={member.phoneNumber} required />
          </Field>
          <Field label="Role" required>
            <Input name="role" defaultValue={member.role} required />
          </Field>
          <Field label="Department">
            <Input name="department" defaultValue={member.department ?? ""} />
          </Field>
          <Button type="submit">Save</Button>
        </form>
      </Card>
    </div>
  );
}
