import { platformPrisma } from "@/server/db";
import { requireAdminSection } from "@/server/mainAdmin";
import { removeJobTitle, saveJobTitle, toggleJobTitle } from "@/server/actions/configuration";
import { NameList } from "../NameList";
import { SuggestedNames } from "../SuggestedNames";
import { NextStep } from "../../NextStep";

export const metadata = { title: "Job Titles" };

export default async function JobTitlesPage() {
  const { allowed, can } = await requireAdminSection("configuration.view");
  if (!allowed) return null;
  const rows = await platformPrisma.jobTitle.findMany({
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: { id: true, name: true, description: true, isActive: true, _count: { select: { employees: true } } },
  });
  const canManage = await can("configuration.manage");
  const [departments, employees] = await Promise.all([platformPrisma.department.count({ where: { isActive: true } }), platformPrisma.employee.count()]);
  const hasActive = rows.some((r) => r.isActive);
  return (
    <div className="space-y-4">
      {canManage && rows.length < 3 ? <SuggestedNames kind="jobTitle" existing={rows.map((r) => r.name)} /> : null}
      <NameList
      noun="job title"
      canManage={canManage}
      rows={rows.map(({ _count, ...row }) => ({ ...row, employeeCount: _count.employees }))}
      save={saveJobTitle}
      toggle={toggleJobTitle}
      remove={removeJobTitle}
    />
      {canManage && hasActive && departments === 0 ? (
        <NextStep title="Add a department" detail="Every employee belongs to a department, such as Customer Support or Sales. Add at least one." href="/admin/configuration/departments" action="Add departments" />
      ) : canManage && hasActive && employees === 0 ? (
        <NextStep title="Add your employees" detail="Departments and job titles are ready. Now add the people who work here." href="/admin/configuration/employees/new" action="Add an employee" />
      ) : null}
    </div>
  );
}
