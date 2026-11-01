import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { MESSAGE_TEMPLATE_STATUS_LABELS, type MessageTemplateStatus } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { Badge, ButtonLink, Card, ViewOnlyNotice } from "@/components/ui";
import { TemplateEditor } from "../TemplateParts";

export const metadata = { title: "Message template" };

/** Create (`/clients/templates/new`) or edit one template, with its version history. */
export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { canManage } = await pageAccess("clients.view", "clients.manage_settings");
  const { id } = await params;
  const isNew = id === "new";
  const t = isNew ? null : await prisma.clientMessageTemplate.findFirst({ where: { id } });
  if (!isNew && !t) notFound();
  const versions = t ? await prisma.clientMessageTemplateVersion.findMany({ where: { templateId: t.id }, orderBy: { version: "desc" }, take: 20, select: { version: true, actorName: true, createdAt: true, subject: true } }) : [];
  return (
    <div className="space-y-5">
      <ButtonLink href="/clients/templates" variant="ghost" size="sm">
        <ArrowLeft className="size-3.5" aria-hidden /> Message Templates
      </ButtonLink>
      <h1 className="flex flex-wrap items-center gap-3 text-[27px] font-semibold tracking-[-0.025em]">
        {t ? t.name : "New template"}
        {t ? <Badge color={t.status === "ACTIVE" ? "green" : t.status === "DRAFT" ? "yellow" : "gray"}>{MESSAGE_TEMPLATE_STATUS_LABELS[t.status as MessageTemplateStatus] ?? t.status}</Badge> : null}
      </h1>
      {canManage ? null : <ViewOnlyNotice />}
      {t?.status === "ARCHIVED" ? <p className="text-sm text-[color:var(--color-muted-foreground)]">Archived: restore it (Move to draft) on the list before editing.</p> : null}
      <TemplateEditor
        canEdit={canManage && t?.status !== "ARCHIVED"}
        initial={{
          id: t?.id ?? null,
          version: t?.version ?? 0,
          name: t?.name ?? "",
          category: t?.category ?? "CUSTOM",
          channel: t?.channel ?? "ANY",
          language: t?.language ?? "",
          subject: t?.subject ?? "",
          body: t?.body ?? "",
          status: t?.status ?? "DRAFT",
        }}
      />
      {versions.length ? (
        <Card className="p-5">
          <h2 className="text-[15px] font-semibold">Versions</h2>
          <ul className="mt-2 divide-y divide-[var(--color-border)] text-sm">
            {versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="font-medium">Version {v.version}</span>
                <span className="text-[color:var(--color-muted-foreground)]">
                  {v.actorName ?? "—"} · {v.createdAt.toLocaleString("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" })}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
