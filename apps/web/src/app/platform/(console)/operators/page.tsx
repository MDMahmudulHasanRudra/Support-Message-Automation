import { prisma as globalPrisma } from "@support-automation/db";
import { Card, PageHeader, SectionHeader } from "@/components/ui";
import { requireOperatorPage } from "@/server/platform/auth";
import { OperatorsClient } from "./OperatorsClient";

export const metadata = { title: "Operators" };

export default async function OperatorsPage() {
  const me = await requireOperatorPage();
  const operators = await globalPrisma.platformOperator.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, username: true, name: true, email: true, isActive: true, canSupport: true, lastLoginAt: true, createdByUsername: true },
  });
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="Operators"
        description="The people who run the platform. Separate from every customer's users: an operator holds no role in any customer's software and enters it only through audited support access."
      />
      <Card>
        <SectionHeader title="Operators" />
        <OperatorsClient
          me={me.operatorId}
          operators={operators.map((o) => ({ ...o, lastLoginAt: o.lastLoginAt?.toISOString() ?? null }))}
        />
      </Card>
    </div>
  );
}
