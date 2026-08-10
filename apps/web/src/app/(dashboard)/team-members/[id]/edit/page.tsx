import { notFound } from "next/navigation";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Button, Card, PageHeader } from "@/components/ui";
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
        <form action={updateWithId} className="space-y-3">
          <div>
            <label className="text-sm font-medium">Name</label>
            <input name="name" defaultValue={member.name} required className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
          </div>
          <div>
            <label className="text-sm font-medium">Phone Number</label>
            <input name="phoneNumber" defaultValue={member.phoneNumber} required className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
          </div>
          <div>
            <label className="text-sm font-medium">Role</label>
            <input name="role" defaultValue={member.role} required className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
          </div>
          <div>
            <label className="text-sm font-medium">Department</label>
            <input name="department" defaultValue={member.department ?? ""} className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
          </div>
          <Button type="submit">Save</Button>
        </form>
      </Card>
    </div>
  );
}
