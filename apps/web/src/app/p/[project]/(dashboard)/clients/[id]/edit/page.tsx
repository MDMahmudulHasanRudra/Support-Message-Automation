import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { CLIENT_STATUS_LABELS, clientDisplayName } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { getClientDetail, loadClientFormOptions } from "@/server/clients";
import { loadClientFormContext } from "@/server/clientFormContext";
import { aliasesOf } from "@/server/clientCodes";
import { activeProjectId } from "@/server/projectContext";
import { Alert, Badge, ButtonLink, Card } from "@/components/ui";
import { ClientForm } from "../../ClientForm";
import { CopyCode } from "../CopyCode";

export const metadata = { title: "Edit client" };

const STATUS_COLOR: Record<string, "green" | "gray" | "yellow" | "red"> = { ACTIVE: "green", INACTIVE: "gray", PENDING: "yellow", ARCHIVED: "gray", BLOCKED: "red" };

/**
 * Edit client (CLIENT_CODES.md §Edit page): the client's contact data on a page of its own, so the 360° profile stays
 * a read view. The same form engine as Add client; quick actions (assign, notes, links, renew, payment) stay on the
 * profile. The code is shown, not edited here with the rest — changing it is its own logged step.
 */
export default async function EditClientPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAccess("clients.update");
  const { id } = await params;
  const detail = await getClientDetail(id);
  if (!detail) notFound();
  const { client } = detail;
  const [options, context, aliases] = await Promise.all([loadClientFormOptions(), loadClientFormContext(session), aliasesOf(prisma, await activeProjectId(), [client.id])]);
  const formerCodes = (aliases.get(client.id) ?? []).filter((c) => c !== client.code);
  const name = clientDisplayName(client.name, client.companyName);
  const initials = (client.name || client.companyName || client.code).trim().slice(0, 2).toUpperCase();

  return (
    <div className="space-y-5">
      <ButtonLink href={`/clients/${client.id}`} variant="ghost" size="sm">
        <ArrowLeft className="size-3.5" aria-hidden />
        Back to {name}
      </ButtonLink>
      <div className="flex items-center gap-4">
        <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-subtle,var(--color-neutral-bg))] text-[15px] font-semibold">
          {initials}
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-[-0.01em] sm:text-2xl">Edit {name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <CopyCode code={client.code} />
            <Badge color={STATUS_COLOR[client.status] ?? "gray"} dot>
              {CLIENT_STATUS_LABELS[client.status]}
            </Badge>
            {formerCodes.length ? <span className="text-[12px] text-[color:var(--color-muted-foreground)]">formerly {formerCodes.join(", ")}</span> : null}
          </div>
        </div>
      </div>
      {client.status === "ARCHIVED" ? (
        <Alert tone="info">This client is archived. Restore it from its profile before editing it. Its channels, notes and history are all kept.</Alert>
      ) : (
        <Card className="max-w-4xl p-6">
          <ClientForm
            mode="edit"
            clientId={client.id}
            options={options}
            context={context}
            values={{
              name: client.name,
              code: client.code,
              companyName: client.companyName ?? "",
              status: client.status,
              category: client.category ?? "",
              tags: client.tags.join(", "),
              preferredChannel: client.preferredChannel ?? "",
              preferredLanguage: client.preferredLanguage ?? "",
              address: client.address ?? "",
              businessDetails: client.businessDetails ?? "",
              followUpInstructions: client.followUpInstructions ?? "",
              assignedMemberId: client.assignedMemberId ?? "",
              assignedTeamId: client.assignedTeamId ?? "",
              country: client.country ?? "",
              preferredCurrency: client.preferredCurrency ?? "",
              soldByMemberId: client.soldByMemberId ?? "",
              businessType: client.businessType ?? "",
              additionalLanguages: client.additionalLanguages.join(", "),
            }}
          />
        </Card>
      )}
    </div>
  );
}
