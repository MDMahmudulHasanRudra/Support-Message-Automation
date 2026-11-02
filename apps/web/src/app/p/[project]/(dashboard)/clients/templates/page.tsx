import { FileText, Plus } from "lucide-react";
import {
  MESSAGE_TEMPLATE_CATEGORY_LABELS,
  MESSAGE_TEMPLATE_CHANNEL_LABELS,
  MESSAGE_TEMPLATE_STATUS_LABELS,
  type MessageTemplateCategory,
  type MessageTemplateChannel,
  type MessageTemplateStatus,
} from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { hasPermission } from "@/server/permissions";
import Link from "@/components/ProjectLink";
import { Badge, ButtonLink, EmptyState, HelpButton, HelpSection, ViewOnlyNotice } from "@/components/ui";
import { ChipTabs, mutedText, surface, type Chip } from "../ModuleKit";
import { TemplateRowActions } from "./TemplateParts";

export const metadata = { title: "Message templates" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const VIEWS = ["active", "draft", "archived", "all"] as const;

/**
 * Client Communication Templates (CLIENT_CRM_V7.md §6): reusable wording for messages to clients, filled with each
 * client's own details. Anyone who can see clients can see the library; changing it is the Client Module settings
 * key. A template sends nothing by itself.
 */
export default async function TemplatesPage({ searchParams }: { searchParams: SearchParams }) {
  const { session, canManage } = await pageAccess("clients.view", "clients.manage_settings");
  const raw = await searchParams;
  const view = (VIEWS as readonly string[]).includes(String(raw.view ?? "")) ? (raw.view as (typeof VIEWS)[number]) : "active";
  const where = view === "all" ? {} : { status: view.toUpperCase() };
  const [rows, counts, canSend] = await Promise.all([
    prisma.clientMessageTemplate.findMany({ where, orderBy: [{ category: "asc" }, { name: "asc" }], take: 500, select: { id: true, name: true, category: true, channel: true, language: true, status: true, version: true, updatedAt: true, updatedByName: true, subject: true, body: true } }),
    prisma.clientMessageTemplate.groupBy({ by: ["status"], _count: { _all: true } }),
    hasPermission(session, "clients.send_messages"),
  ]);
  const count = (s: string) => counts.find((c) => c.status === s)?._count._all ?? 0;
  const chips: Chip[] = VIEWS.map((v) => ({
    key: v,
    label: v === "all" ? "All" : MESSAGE_TEMPLATE_STATUS_LABELS[v.toUpperCase() as MessageTemplateStatus],
    count: v === "all" ? counts.reduce((n, c) => n + c._count._all, 0) : count(v.toUpperCase()),
    href: `/clients/templates${v === "active" ? "" : `?view=${v}`}`,
    active: view === v,
  }));

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] sm:text-[28px]">Message Templates</h1>
          <p className={`mt-1 text-sm ${mutedText}`}>Wording for welcome, renewal, invoice, payment and receipt messages, filled with each client&apos;s own details.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManage ? (
            <ButtonLink href="/clients/templates/new" variant="primary" size="md">
              <Plus className="size-4" aria-hidden /> New template
            </ButtonLink>
          ) : null}
          <HelpButton moduleTitle="Message Templates">
            <HelpSection title="Variables">
              <p>Write {"{{client_name}}"}, {"{{invoice_number}}"} and so on; each is filled from the client&apos;s own records when a message is prepared. A line whose only content is a variable with no value is left out, never shown half-empty.</p>
            </HelpSection>
            <HelpSection title="Nothing is sent by a template">
              <p>Only Active templates are offered when preparing a message. Email is sent by Get Assist after a person presses Send (or, in bulk, after a second person approves). WhatsApp wording is prepared for a person to send.</p>
            </HelpSection>
            <HelpSection title="Versions">
              <p>Each save is a new version and messages record the version they used, so what a client was sent stays answerable after the wording changes.</p>
            </HelpSection>
          </HelpButton>
        </div>
      </div>
      {canManage ? null : <ViewOnlyNotice />}
      <ChipTabs label="Template views" chips={chips} />
      {rows.length === 0 ? (
        <EmptyState>{view === "active" ? "No active template yet. Create one, check it, then activate it." : "No template here."}</EmptyState>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((t) => (
            <li key={t.id} className={`${surface} flex flex-col p-4`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link href={`/clients/templates/${t.id}`} className="flex items-center gap-2 font-semibold hover:underline">
                    <FileText className={`size-4 shrink-0 ${mutedText}`} aria-hidden />
                    <span className="truncate">{t.name}</span>
                  </Link>
                  <p className={`mt-0.5 text-xs ${mutedText}`}>
                    {MESSAGE_TEMPLATE_CATEGORY_LABELS[t.category as MessageTemplateCategory] ?? t.category} · {MESSAGE_TEMPLATE_CHANNEL_LABELS[t.channel as MessageTemplateChannel] ?? t.channel}
                    {t.language ? ` · ${t.language}` : ""}
                  </p>
                </div>
                <Badge color={t.status === "ACTIVE" ? "green" : t.status === "DRAFT" ? "yellow" : "gray"}>{MESSAGE_TEMPLATE_STATUS_LABELS[t.status as MessageTemplateStatus] ?? t.status}</Badge>
              </div>
              {t.subject ? <p className="mt-3 truncate text-sm font-medium">{t.subject}</p> : null}
              <p className={`mt-1 line-clamp-4 whitespace-pre-wrap text-sm ${mutedText}`}>{t.body}</p>
              <div className={`mt-auto flex items-center justify-between gap-2 pt-3 text-xs ${mutedText}`}>
                <span>
                  v{t.version} · {t.updatedByName ?? "—"} · {t.updatedAt.toLocaleDateString("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium" })}
                </span>
                {canManage ? <TemplateRowActions id={t.id} status={t.status} /> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {canSend ? <p className={`text-xs ${mutedText}`}>To send: open a client, invoice or receipt and press Message client, or select clients on All Clients for a bulk email.</p> : null}
    </div>
  );
}
