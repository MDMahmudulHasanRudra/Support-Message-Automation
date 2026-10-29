import { requireAccess } from "@/server/authorize";
import { clientOptions } from "@/server/commerce";
import { ButtonLink, Card, PageHeader } from "@/components/ui";
import { LeadForm } from "../LeadForm";

export const metadata = { title: "New lead" };

export default async function NewLeadPage() {
  await requireAccess("sales.manage");
  const clients = await clientOptions();
  return (
    <div>
      <PageHeader title="New lead" actions={<ButtonLink href="/sales">Back to pipeline</ButtonLink>} />
      <Card>
        <LeadForm clients={clients} />
      </Card>
    </div>
  );
}
