import { requireAccess } from "@/server/authorize";
import { loadClientFormOptions } from "@/server/clients";
import { Card, PageHeader } from "@/components/ui";
import { ClientForm, EMPTY_CLIENT_VALUES } from "../ClientForm";

export default async function NewClientPage() {
  await requireAccess("clients.create");
  const options = await loadClientFormOptions();
  return (
    <div>
      <PageHeader title="Add client" description="Create a client record. Matching phone numbers, emails and codes are shown before anything is saved." />
      <Card className="max-w-3xl p-6">
        <ClientForm mode="create" values={EMPTY_CLIENT_VALUES} options={options} />
      </Card>
    </div>
  );
}
