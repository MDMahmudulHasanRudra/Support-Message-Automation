import { platformPrisma } from "@/server/db";
import { requireAdminSection } from "@/server/mainAdmin";
import { removeJobTitle, saveJobTitle, toggleJobTitle } from "@/server/actions/configuration";
import { NameList } from "../NameList";

export const metadata = { title: "Job Titles" };

export default async function JobTitlesPage() {
  const { allowed, can } = await requireAdminSection("configuration.view");
  if (!allowed) return null;
  const rows = await platformPrisma.jobTitle.findMany({
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: { id: true, name: true, description: true, isActive: true, _count: { select: { employees: true } } },
  });
  return (
    <NameList
      noun="job title"
      canManage={await can("configuration.manage")}
      rows={rows.map(({ _count, ...row }) => ({ ...row, employeeCount: _count.employees }))}
      save={saveJobTitle}
      toggle={toggleJobTitle}
      remove={removeJobTitle}
    />
  );
}
