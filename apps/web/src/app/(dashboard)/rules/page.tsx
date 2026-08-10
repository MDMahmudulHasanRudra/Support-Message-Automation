import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Badge, Button, PageHeader, Table, Td, Th } from "@/components/ui";
import { deleteRule, duplicateRule, setRuleStatus, updatePriority } from "@/server/actions/rules";
import { isRuleActionArray } from "@support-automation/shared";

export default async function RulesPage() {
  await requireSession();
  const rules = await prisma.automationRule.findMany({ orderBy: [{ priority: "desc" }, { createdAt: "desc" }] });

  return (
    <div>
      <PageHeader title="Automation Rules" description="Higher priority rules are evaluated first." />

      <div className="mb-4 flex justify-end">
        <Link href="/rules/new">
          <Button>Create Rule</Button>
        </Link>
      </div>

      <Table>
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Type</Th>
            <Th>Trigger</Th>
            <Th>Actions</Th>
            <Th>Priority</Th>
            <Th>Status</Th>
            <Th>Executions</Th>
            <Th>Last Modified</Th>
            <Th>Manage</Th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => {
            const actions = isRuleActionArray(rule.actions) ? rule.actions : [];
            return (
              <tr key={rule.id}>
                <Td>{rule.name}</Td>
                <Td>{rule.type}</Td>
                <Td>
                  {rule.matchType}
                  {rule.matchValue ? `: ${rule.matchValue}` : rule.keywords.length ? `: ${rule.keywords.join(", ")}` : ""}
                </Td>
                <Td>{actions.map((a) => a.type).join(", ") || "—"}</Td>
                <Td>
                  <div className="flex items-center gap-1">
                    <form action={updatePriority.bind(null, rule.id, rule.priority + 10)}>
                      <button type="submit" className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">▲</button>
                    </form>
                    {rule.priority}
                    <form action={updatePriority.bind(null, rule.id, rule.priority - 10)}>
                      <button type="submit" className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">▼</button>
                    </form>
                  </div>
                </Td>
                <Td>
                  <Badge color={rule.status === "ACTIVE" ? "green" : rule.status === "DRAFT" ? "yellow" : "gray"}>
                    {rule.status}
                  </Badge>
                </Td>
                <Td>{rule.executionCount}</Td>
                <Td>{rule.updatedAt.toLocaleDateString()}</Td>
                <Td>
                  <div className="flex flex-wrap gap-2">
                    <Link href={`/rules/${rule.id}/edit`}>
                      <Button variant="secondary">Edit</Button>
                    </Link>
                    <form action={duplicateRule.bind(null, rule.id)}>
                      <Button variant="secondary" type="submit">Duplicate</Button>
                    </form>
                    {rule.status === "ACTIVE" ? (
                      <form action={setRuleStatus.bind(null, rule.id, "DISABLED")}>
                        <Button variant="secondary" type="submit">Disable</Button>
                      </form>
                    ) : (
                      <form action={setRuleStatus.bind(null, rule.id, "ACTIVE")}>
                        <Button variant="secondary" type="submit">Enable</Button>
                      </form>
                    )}
                    <form action={deleteRule.bind(null, rule.id)}>
                      <Button variant="danger" type="submit">Delete</Button>
                    </form>
                  </div>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}
