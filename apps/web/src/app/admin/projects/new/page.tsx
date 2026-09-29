import { Card, PageHeader } from "@/components/ui";
import { requireMainAdminManagePage } from "@/server/mainAdmin";
import { CreateProjectForm } from "./CreateProjectForm";

export const metadata = { title: "Create project" };

export default async function NewProjectPage() {
  await requireMainAdminManagePage();
  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Create project"
        description="A new project starts clean: nothing is copied from any other project. It gets its own default settings (automation off, AI off), the default shifts and alert settings, and you get access to it. WhatsApp numbers, AI providers, rules, teams and knowledge are then set up inside the project."
      />
      <Card>
        <CreateProjectForm />
      </Card>
    </div>
  );
}
