import { PageHeader } from "@/components/ui";
import { requireAccess } from "@/server/authorize";
import { CaseList } from "../CaseList";

/** The cases assigned to the team member linked to this login, still waiting on them. */
export default async function MyAssignmentsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requireAccess("support_assignment.view");
  return (
    <div>
      <PageHeader title="My assignments" description="Customers assigned to you who are still waiting for your reply. Reply in the group and the case completes itself." />
      <CaseList session={session} view="mine" basePath="/support-assignment/mine" params={await searchParams} />
    </div>
  );
}
