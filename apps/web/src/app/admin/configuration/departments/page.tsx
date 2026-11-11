import { platformPrisma } from "@/server/db";
import { requireAdminSection } from "@/server/mainAdmin";
import { removeDepartment, saveDepartment, toggleDepartment } from "@/server/actions/configuration";
import { NameList } from "../NameList";
import { SuggestedNames } from "../SuggestedNames";
import { NextStep } from "../../NextStep";

export const metadata = { title: "Departments" };

export default async function DepartmentsPage() {
  const { allowed, can } = await requireAdminSection("configuration.view");
  if (!allowed) return null;
  const rows = await platformPrisma.department.findMany({
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: { id: true, name: true, code: true, description: true, isActive: true, _count: { select: { employees: true } } },
  });
  const canManage = await can("configuration.manage");
  const [jobTitles, employees] = await Promise.all([platformPrisma.jobTitle.count({ where: { isActive: true } }), platformPrisma.employee.count()]);
  const hasActive = rows.some((r) => r.isActive);
  return (
    <div className="space-y-4">
      {canManage && rows.length < 3 ? <SuggestedNames kind="department" existing={rows.map((r) => r.name)} /> : null}
      <NameList
      noun="department"
      withCode
      canManage={canManage}
      rows={rows.map(({ _count, ...row }) => ({ ...row, employeeCount: _count.employees }))}
      save={saveDepartment}
      toggle={toggleDepartment}
      remove={removeDepartment}
    />
      {canManage && hasActive && jobTitles === 0 ? (
        <NextStep title="Add job titles" detail="Each employee has a job title, such as Support Agent or Manager. Add the ones your team uses." href="/admin/configuration/job-titles" action="Add job titles" />
      ) : canManage && hasActive && employees === 0 ? (
        <NextStep title="Add your employees" detail="Departments and job titles are ready. Now add the people who work here." href="/admin/configuration/employees/new" action="Add an employee" />
      ) : null}
    </div>
  );
}
