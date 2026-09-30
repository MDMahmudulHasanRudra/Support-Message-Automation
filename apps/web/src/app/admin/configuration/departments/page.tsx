import { platformPrisma } from "@/server/db";
import { requireAdminSection } from "@/server/mainAdmin";
import { removeDepartment, saveDepartment, toggleDepartment } from "@/server/actions/configuration";
import { NameList } from "../NameList";

export const metadata = { title: "Departments" };

export default async function DepartmentsPage() {
  const { allowed, can } = await requireAdminSection("configuration.view");
  if (!allowed) return null;
  const rows = await platformPrisma.department.findMany({
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: { id: true, name: true, code: true, description: true, isActive: true, _count: { select: { employees: true } } },
  });
  return (
    <NameList
      noun="department"
      withCode
      canManage={await can("configuration.manage")}
      rows={rows.map(({ _count, ...row }) => ({ ...row, employeeCount: _count.employees }))}
      save={saveDepartment}
      toggle={toggleDepartment}
      remove={removeDepartment}
    />
  );
}
