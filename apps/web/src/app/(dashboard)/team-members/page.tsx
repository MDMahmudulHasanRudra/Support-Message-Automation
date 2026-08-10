import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Badge, Button, Card, PageHeader, Table, Td, Th } from "@/components/ui";
import { createTeamMember, deleteTeamMember, toggleTeamMemberStatus } from "@/server/actions/teamMembers";

export default async function TeamMembersPage() {
  await requireSession();
  const members = await prisma.internalTeamMember.findMany({ orderBy: { createdAt: "desc" } });

  return (
    <div>
      <PageHeader
        title="Internal Team Members"
        description="Messages from active team members are ignored by client automation by default."
      />

      <Card className="mb-6">
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Add Team Member</h2>
        <form action={createTeamMember} className="grid grid-cols-1 gap-3 md:grid-cols-5">
          <input name="name" placeholder="Name" required className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
          <input name="phoneNumber" placeholder="+8801XXXXXXXXX" required className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
          <input name="role" placeholder="Role" required className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
          <input name="department" placeholder="Department (optional)" className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
          <Button type="submit">Add</Button>
        </form>
      </Card>

      <Table>
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Phone</Th>
            <Th>Role</Th>
            <Th>Department</Th>
            <Th>Status</Th>
            <Th>Actions</Th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <Td>{m.name}</Td>
              <Td>{m.phoneNumber}</Td>
              <Td>{m.role}</Td>
              <Td>{m.department ?? "—"}</Td>
              <Td>
                <Badge color={m.status === "ACTIVE" ? "green" : "gray"}>{m.status}</Badge>
              </Td>
              <Td>
                <div className="flex gap-2">
                  <Link href={`/team-members/${m.id}/edit`}>
                    <Button variant="secondary">Edit</Button>
                  </Link>
                  <form action={toggleTeamMemberStatus.bind(null, m.id)}>
                    <Button variant="secondary" type="submit">
                      {m.status === "ACTIVE" ? "Disable" : "Enable"}
                    </Button>
                  </form>
                  <form action={deleteTeamMember.bind(null, m.id)}>
                    <Button variant="danger" type="submit">
                      Delete
                    </Button>
                  </form>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
