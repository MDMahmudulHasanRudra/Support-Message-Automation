import { Download, Search, ShieldCheck } from "lucide-react";
import { Badge, ButtonLink, EmptyState, Input, PageHeader, Pagination, Select, Table, Td, Th } from "@/components/ui";
import Link from "@/components/ProjectLink";
import { pageAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { listWebsiteVisitors, VISITOR_PAGE_SIZE, type VisitorFilters } from "@/server/websiteChat";
import { AutoSubmitForm } from "../../clients/AutoSubmitForm";

export const metadata = { title: "Website visitors" };

const DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const hostOf = (url: string | null) => {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Everyone who has chatted through a widget, and everything they told us or we could see about their visit. */
export default async function WebsiteVisitorsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await pageAccess("messages.view", "messages.view", "OMNICHANNEL");
  const params = await searchParams;
  const filters: VisitorFilters = { q: params.q ?? "", widget: params.widget ?? "", contact: params.contact === "yes" || params.contact === "no" ? params.contact : "" };
  const page = Math.max(1, Number(params.page) || 1);
  const [{ total, visitors }, widgets] = await Promise.all([
    listWebsiteVisitors(filters, page),
    prisma.channelConnection.findMany({ where: { type: "WEBCHAT" }, select: { id: true, name: true }, orderBy: { createdAt: "asc" } }),
  ]);
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as Array<[string, string]>).toString();
  const buildHref = (p: number) => `/website-chat/visitors?${query}${query ? "&" : ""}page=${p}`;

  return (
    <div>
      <PageHeader
        title="Visitors"
        description="Everyone who has chatted on your websites: what they told you, and how they arrived."
        actions={
          <ButtonLink href={`/api/website-chat/visitors/export${query ? `?${query}` : ""}`} variant="secondary">
            <Download className="size-4" aria-hidden />
            Export CSV
          </ButtonLink>
        }
      />
      <AutoSubmitForm className="mb-4 flex flex-wrap items-center gap-2 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-xs),var(--highlight-top)]">
        <label className="relative min-w-0 flex-1 basis-full sm:basis-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[color:var(--color-muted-foreground)]" aria-hidden />
          <Input name="q" defaultValue={filters.q} placeholder="Search name, phone or email…" aria-label="Search visitors" className="pl-9" />
        </label>
        {widgets.length > 1 ? (
          <Select name="widget" defaultValue={filters.widget} aria-label="Website" className="sm:w-48">
            <option value="">All websites</option>
            {widgets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        ) : null}
        <Select name="contact" defaultValue={filters.contact} aria-label="Contact details" className="sm:w-48">
          <option value="">Any contact details</option>
          <option value="yes">Left a phone or email</option>
          <option value="no">No contact details</option>
        </Select>
        <span className="ml-auto text-xs text-[color:var(--color-muted-foreground)]">
          {total.toLocaleString()} visitor{total === 1 ? "" : "s"}
        </span>
      </AutoSubmitForm>

      {visitors.length === 0 ? (
        <EmptyState>{query ? "No visitor matches these filters." : "Nobody has chatted yet. Visitors appear here as soon as they start a chat."}</EmptyState>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Visitor</Th>
                <Th>Contact</Th>
                <Th>How they arrived</Th>
                <Th>Device</Th>
                <Th>Visits</Th>
                <Th>Last seen</Th>
                <Th>{null}</Th>
              </tr>
            </thead>
            <tbody>
              {visitors.map((v) => {
                const answers = Array.isArray(v.customAnswers) ? (v.customAnswers as Array<{ label: string; value: string }>) : [];
                const phone = v.phone ?? v.typedPhone;
                const campaign = [v.utmSource, v.utmMedium, v.utmCampaign].filter(Boolean).join(" / ");
                return (
                  <tr key={v.id} className="align-top">
                    <Td className="max-w-52">
                      <p className="flex items-center gap-1.5 font-medium">
                        <span className="truncate">{v.name ?? "Name not given"}</span>
                        {v.verifiedExternalId ? <ShieldCheck className="size-3.5 shrink-0 text-[color:var(--color-success-fg)]" aria-label="Signed in on the website" /> : null}
                      </p>
                      <p className="truncate text-xs text-[color:var(--color-muted-foreground)]">{v.connection.name}</p>
                      {answers.length ? (
                        <details className="mt-1 text-xs">
                          <summary className="cursor-pointer text-[color:var(--color-accent-fg)]">
                            {answers.length} answer{answers.length === 1 ? "" : "s"}
                          </summary>
                          <dl className="mt-1 space-y-1">
                            {answers.map((a) => (
                              <div key={a.label}>
                                <dt className="text-[color:var(--color-muted-foreground)]">{a.label}</dt>
                                <dd>{a.value}</dd>
                              </div>
                            ))}
                          </dl>
                        </details>
                      ) : null}
                    </Td>
                    <Td className="max-w-56">
                      {phone ? <p className="tabular-nums">+{phone}</p> : null}
                      {v.email ? <p className="truncate" title={v.email}>{v.email}</p> : null}
                      {!phone && !v.email ? <span className="text-[color:var(--color-muted-foreground)]">None</span> : null}
                      {v.consentAt ? <Badge color="green">Consent given</Badge> : null}
                    </Td>
                    <Td className="max-w-64 text-xs">
                      <p className="truncate" title={v.firstPageUrl ?? undefined}>{v.firstPageUrl ? `Landed on ${v.firstPageUrl.replace(/^https?:\/\//, "")}` : "Direct chat link"}</p>
                      <p className="truncate text-[color:var(--color-muted-foreground)]">{v.referrer ? `From ${hostOf(v.referrer)}` : "No referring site"}</p>
                      {campaign ? <p className="truncate text-[color:var(--color-muted-foreground)]" title={campaign}>Campaign: {campaign}</p> : null}
                    </Td>
                    <Td className="whitespace-nowrap text-xs">
                      <p>{[v.device, v.os].filter(Boolean).join(" · ") || "—"}</p>
                      <p className="text-[color:var(--color-muted-foreground)]">{[v.browser, v.language].filter(Boolean).join(" · ")}</p>
                      {v.timeZone ? <p className="text-[color:var(--color-muted-foreground)]">{v.timeZone}</p> : null}
                    </Td>
                    <Td className="tabular-nums">{v.visitCount}</Td>
                    <Td className="whitespace-nowrap text-xs">{DAY.format(v.lastSeenAt)}</Td>
                    <Td>
                      {v.conversation ? (
                        <Link href={`/conversations/website/c/${v.conversation.id}`} className="link text-xs">
                          Open chat
                        </Link>
                      ) : (
                        <span className="text-xs text-[color:var(--color-muted-foreground)]">No message yet</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <Pagination page={page} pageSize={VISITOR_PAGE_SIZE} total={total} buildHref={buildHref} />
        </>
      )}
    </div>
  );
}
