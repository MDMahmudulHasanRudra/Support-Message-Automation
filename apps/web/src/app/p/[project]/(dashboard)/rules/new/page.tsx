import { requireAccess } from "@/server/authorize";
import { PageHeader } from "@/components/ui";
import { createRule } from "@/server/actions/rules";
import { RuleForm } from "../RuleForm";

export default async function NewRulePage() {
  await requireAccess("automation_rules.create");
  return (
    <div>
      <PageHeader title="Create Automation Rule" />
      <RuleForm action={createRule} submitLabel="Create Rule" />
    </div>
  );
}
