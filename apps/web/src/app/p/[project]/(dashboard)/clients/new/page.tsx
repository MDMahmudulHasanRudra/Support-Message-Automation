import { requireAccess } from "@/server/authorize";
import { loadClientFormOptions } from "@/server/clients";
import { loadClientFormContext } from "@/server/clientFormContext";
import { Card, PageHeader } from "@/components/ui";
import { ClientForm, EMPTY_CLIENT_VALUES } from "../ClientForm";

export default async function NewClientPage() {
  const session = await requireAccess("clients.create");
  const [options, context] = await Promise.all([loadClientFormOptions(), loadClientFormContext(session)]);
  return (
    <div>
      <PageHeader title="Add client" description="A guided form: enter only what you know. Matching numbers, emails and codes are shown before anything is saved." />
      <Card className="max-w-4xl p-6">
        <ClientForm mode="create" values={EMPTY_CLIENT_VALUES} options={options} context={context} />
      </Card>
    </div>
  );
}
