import { RULE_TEMPLATES } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import Link from "@/components/ProjectLink";
import { Card, PageHeader } from "@/components/ui";
import { AddRuleTemplateButton } from "./AddRuleTemplateButton";

export const metadata = { title: "Rule templates" };

/** Ready-made auto-reply rules (MENU_BOTS.md). Each is added as a draft: nothing here answers anyone by itself. */
export default async function RuleTemplatesPage() {
  const session = await requireAccess("automation_rules.view");
  const canCreate = await hasPermission(session, "automation_rules.create");
  return (
    <div className="min-w-0">
      <PageHeader title="Templates" description="Ready-made replies. Add one as a draft, put in your own details, then switch it on." />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {RULE_TEMPLATES.map((t) => (
          <Card key={t.id} className="flex flex-col p-4">
            <h2 className="text-[14.5px] font-semibold">{t.name}</h2>
            <p className="mt-0.5 text-[13px] text-[color:var(--color-muted-foreground)]">{t.description}</p>
            <p className="mt-2.5 flex-1 whitespace-pre-wrap rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-3 py-2 text-[13px]">{t.replyMessage}</p>
            <p className="mt-2 truncate text-[12.5px] text-[color:var(--color-muted-foreground)]">
              {t.timeWindow ? `From ${t.timeWindow.startHour}:00 to ${t.timeWindow.endHour}:00` : `Answers: ${t.keywords.join(", ")}`}
            </p>
            {canCreate ? (
              <div className="mt-3">
                <AddRuleTemplateButton id={t.id} />
              </div>
            ) : null}
          </Card>
        ))}
      </div>
      <p className="mt-4 text-[13px] text-[color:var(--color-muted-foreground)]">
        Want customers to choose from a numbered list instead?{" "}
        <Link href="/menu-bots" className="link">
          Use a menu bot
        </Link>
        .
      </p>
    </div>
  );
}
