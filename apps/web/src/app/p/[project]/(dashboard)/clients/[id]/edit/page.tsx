import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { CLIENT_STATUS_LABELS, clientDisplayName } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { getClientDetail, loadClientFormOptions } from "@/server/clients";
import { loadClientFormContext } from "@/server/clientFormContext";
import { aliasesOf } from "@/server/clientCodes";
import { activeProjectId } from "@/server/projectContext";
import Link from "@/components/ProjectLink";
import { Alert, Badge, Card } from "@/components/ui";
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
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-sm text-[color:var(--color-muted-foreground)]">
        <Link href="/clients" className="hover:text-[color:var(--color-foreground)] hover:underline">
          All Clients
        </Link>
        <span aria-hidden>/</span>
        <Link href={`/clients/${client.id}`} className="inline-flex items-center gap-1 hover:text-[color:var(--color-foreground)] hover:underline">
          <ArrowLeft className="size-3.5" aria-hidden />
          {name}
        </Link>
        <span aria-hidden>/</span>
        <span className="text-[color:var(--color-foreground)]">Edit</span>
      </nav>
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
        <div className="grid gap-6 xl:grid-cols-[minmax(0,56rem)_180px]">
        <Card className="p-6">
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
          <aside className="hidden xl:block">
            <nav aria-label="Form sections" className="sticky top-24 space-y-1 text-sm">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-[color:var(--color-muted-foreground)]">On this page</p>
              {[
                ["client-identity", "Identity"],
                ["client-contact", "Contact & currency"],
                ["client-team", "Team & seller"],
                ["client-notes", "Notes"],
              ].map(([anchor, label]) => (
                <a key={anchor} href={`#${anchor}`} className="block rounded-[var(--radius-sm)] px-2 py-1 text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]">
                  {label}
                </a>
              ))}
              <p className="pt-3 text-xs text-[color:var(--color-muted-foreground)]">Subscriptions, payments, notes and links stay on the profile; the client code changes through its own logged step.</p>
            </nav>
          </aside>
        </div>
      )}
    </div>
  );
}
