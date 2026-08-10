import { requireSession } from "@/server/auth";
import { PageHeader } from "@/components/ui";
import { createRule } from "@/server/actions/rules";
import { RuleForm } from "../RuleForm";

export default async function NewRulePage() {
  await requireSession();
  return (
    <div>
      <PageHeader title="Create Automation Rule" />
      <RuleForm action={createRule} submitLabel="Create Rule" />
    </div>
  );
}
