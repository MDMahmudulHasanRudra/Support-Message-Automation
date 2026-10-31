import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { clientCodeTenantKey, readClientCodeSeries, reservedClientCodePrefixes } from "@support-automation/db";
import { formatClientCode } from "@support-automation/shared";
import { ButtonLink, PageHeader, ViewOnlyNotice } from "@/components/ui";
import { globalPrisma } from "@/server/db";
import { getProjectDetail, requireMainAdminPage } from "@/server/mainAdmin";
import { clientCodeConversionEnabled } from "@/server/clientCodeSettings";
import { ClientCodesPanel } from "./ClientCodesPanel";

export const metadata = { title: "Client codes" };

/**
 * Main Admin → Project → Client codes (CLIENT_CODES.md): the project's code series, its history, and the reviewed
 * conversion of codes clients already have. Visible to `projects.view`; every change needs `projects.manage`, which
 * each action checks again.
 */
export default async function ProjectClientCodesPage({ params }: { params: Promise<{ id: string }> }) {
  const { session, canManage } = await requireMainAdminPage();
  const { id } = await params;
  const detail = await getProjectDetail(session.userId, id);
  if (!detail) notFound();

  const [series, tenantKey, counts] = await Promise.all([
    readClientCodeSeries(globalPrisma, id),
    clientCodeTenantKey(globalPrisma, id),
    globalPrisma.$queryRaw<Array<{ clients: bigint; legacy: bigint; aliases: bigint }>>`
      SELECT (SELECT count(*) FROM "Client" WHERE "projectId" = ${id}) AS "clients",
             (SELECT count(*) FROM "Client" WHERE "projectId" = ${id} AND upper("code") ~ '^CL-[0-9]{6,}$') AS "legacy",
             (SELECT count(*) FROM "ClientCodeAlias" WHERE "projectId" = ${id}) AS "aliases"`,
  ]);
  const reserved = await reservedClientCodePrefixes(globalPrisma, tenantKey);
  const live = series.find((s) => !s.retiredAt);
  const c = counts[0]!;

  return (
    <div>
      <ButtonLink href={`/admin/projects/${id}`} variant="ghost" size="sm" className="mb-3">
        <ArrowLeft className="size-3.5" aria-hidden />
        {detail.project.name}
      </ButtonLink>
      <PageHeader
        title="Client codes"
        description="The codes people see and type for this project's clients. A client's identity never changes with its code: invoices, receipts, payments, chats and history stay with the same client."
      />
      {canManage ? null : (
        <div className="mb-6">
          <ViewOnlyNotice />
        </div>
      )}
      <ClientCodesPanel
        projectId={id}
        projectName={detail.project.name}
        canManage={canManage}
        applyEnabled={clientCodeConversionEnabled()}
        live={
          live
            ? {
                prefix: live.prefix,
                isPrimary: live.isPrimary,
                minWidth: live.minWidth,
                nextSerial: live.nextSerial,
                version: live.version,
                lastIssued: BigInt(live.nextSerial) > BigInt(1) ? formatClientCode(live.prefix, BigInt(live.nextSerial) - BigInt(1), live.minWidth) : null,
              }
            : null
        }
        history={series.map((s) => ({
          version: s.version,
          prefix: s.prefix,
          minWidth: s.minWidth,
          nextSerial: s.nextSerial,
          createdAt: s.createdAt.toISOString(),
          retiredAt: s.retiredAt?.toISOString() ?? null,
        }))}
        reserved={reserved.filter((r) => r.projectId !== id).map((r) => ({ prefix: r.prefix, projectName: r.projectName, retired: r.retired }))}
        counts={{ clients: Number(c.clients), legacy: Number(c.legacy), aliases: Number(c.aliases) }}
      />
    </div>
  );
}
