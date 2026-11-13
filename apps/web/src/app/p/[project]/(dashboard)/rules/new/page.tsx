import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { PageHeader } from "@/components/ui";
import { createRule } from "@/server/actions/rules";
import { QuickRuleForm } from "../QuickRuleForm";

export default async function NewRulePage() {
  const session = await requireAccess("automation_rules.create");
  const canActivate = await hasPermission(session, "automation_rules.activate");
  return (
    <div>
      <PageHeader
        title="New automation rule"
        description="Type the words a customer might write, type the reply, and save."
      />
      <QuickRuleForm action={createRule} canActivate={canActivate} />
    </div>
  );
}
