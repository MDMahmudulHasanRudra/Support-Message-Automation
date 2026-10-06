import { PageHeader } from "@/components/ui";
import { requireAccess } from "@/server/authorize";
import { CaseList } from "../CaseList";

/** Finished cases: completed by the assignee, answered by someone else, cancelled, or filtered out. */
export default async function CompletedCasesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requireAccess("support_assignment.view");
  return (
    <div>
      <PageHeader
        title="Completed"
        description="Every finished case, newest first. Ignored shows the messages the ignore rules filtered out, so the filtering can be checked."
      />
      <CaseList session={session} view="closed" basePath="/support-assignment/completed" params={await searchParams} />
    </div>
  );
}
