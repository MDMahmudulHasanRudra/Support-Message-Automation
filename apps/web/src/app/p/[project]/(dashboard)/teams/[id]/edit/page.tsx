import { prisma } from "@/server/db";
import { notFound } from "next/navigation";

import { requireAccess } from "@/server/authorize";
import { Card, PageHeader } from "@/components/ui";
import { TeamForm } from "../../TeamForm";

export const metadata = { title: "Edit team" };

export default async function EditTeamPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAccess("whatsapp.manage");
  const { id } = await params;
  const team = await prisma.team.findUnique({ where: { id } });
  if (!team) notFound();

  return (
    <div>
      <PageHeader title={`Edit ${team.name}`} description="Renaming a team changes the name everywhere, including past reports." />
      <Card className="max-w-lg">
        <TeamForm
          teamId={team.id}
          defaults={{ name: team.name, code: team.code, description: team.description, status: team.status }}
        />
      </Card>
    </div>
  );
}
