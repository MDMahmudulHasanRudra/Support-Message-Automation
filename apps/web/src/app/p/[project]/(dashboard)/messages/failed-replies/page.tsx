import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { prisma } from "@/server/db";
import { disabledFeaturesFor } from "@/server/projectFeatures";
import { activeProjectId } from "@/server/projectContext";
import { AutoRefresh } from "@/components/AutoRefresh";
import Link from "@/components/ProjectLink";
import { Button, ButtonLink, Field, FilterBar, HelpButton, HelpSection, Input, PageHeader, Pagination, Select } from "@/components/ui";
import { FAILED_REPLY_STATE_LABELS, FAILED_REPLY_STATES } from "@support-automation/shared";
import { FAILED_REPLY_PAGE_SIZES, listFailedReplies, parseFailedReplyFilters } from "@/server/failedReplies";
import { FailedRepliesTable } from "./FailedRepliesTable";

const DEFAULT_PAGE_SIZE = 50;
const CHANNEL_TYPES = [
  ["MESSENGER", "Messenger"],
  ["INSTAGRAM", "Instagram"],
  ["TELEGRAM", "Telegram"],
  ["WEBCHAT", "Website chat"],
] as const;

/**
 * Messages → Failed Replies (FAILED_REPLIES.md): every customer reply that did not go out — an automatic
 * reply, an AI answer, or one a person typed — on WhatsApp and, with All Conversations on, the other
 * channels. What happened, whether the customer may have received it anyway, and what can safely be done.
 */
export default async function FailedRepliesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requireAccess("messages.view");
  const disabled = await disabledFeaturesFor(await activeProjectId());
  const includeChannels = !disabled.has("OMNICHANNEL");
  const [canWhatsApp, canChannels] = await Promise.all([hasPermission(session, "messages.reply"), includeChannels ? hasPermission(session, "conversations.reply") : Promise.resolve(false)]);

  const params = await searchParams;
  const filters = parseFailedReplyFilters(params);
  const page = Math.max(1, Number(params.page ?? "1") || 1);
  const requested = Number(params.pageSize ?? DEFAULT_PAGE_SIZE);
  const pageSize = (FAILED_REPLY_PAGE_SIZES as readonly number[]).includes(requested) ? requested : DEFAULT_PAGE_SIZE;

  const [{ rows, total, counts }, accounts] = await Promise.all([
    listFailedReplies(filters, page, pageSize, includeChannels),
    prisma.whatsAppAccount.findMany({ select: { id: true, label: true }, orderBy: { createdAt: "asc" } }),
  ]);

  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) if (value && key !== "page" && key !== "pageSize") query[key] = value;
  const href = (overrides: Record<string, string | null>) => {
    const qs = new URLSearchParams(query);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null) qs.delete(k);
      else qs.set(k, v);
    }
    const s = qs.toString();
    return `/messages/failed-replies${s ? `?${s}` : ""}`;
  };

  const chips: Array<{ key: string; label: string; count: number | null }> = [
    { key: "open", label: "Needs action", count: counts.FAILED + counts.RETRYING },
    ...FAILED_REPLY_STATES.map((s) => ({ key: s, label: FAILED_REPLY_STATE_LABELS[s], count: counts[s] })),
    { key: "all", label: "All", count: counts.FAILED + counts.RETRYING + counts.RESOLVED + counts.CLOSED },
  ];

  return (
    <div>
      {/* A retried reply moves to Retrying and then Resolved as the worker sends it; follow without a reload. */}
      <AutoRefresh intervalMs={15000} />
      <PageHeader
        title="Failed Replies"
        description="Customer replies that did not go out — what happened, whether the customer may have received them anyway, and what can safely be done."
        actions={
          <HelpButton moduleTitle="Failed Replies">
            <HelpSection title="What is listed">
              <p>
                Replies to customers that failed: automatic replies (rules and AI) and replies typed in WhatsApp Chat
                {includeChannels ? ", and replies on Messenger, Instagram, Telegram and website chat" : ""}. Broadcasts and internal
                alerts have their own views and are not listed here.
              </p>
            </HelpSection>
            <HelpSection title="Delivery uncertain">
              <p>
                The send started and never answered — a timeout or a closed browser page — so the customer may already have the
                message. Such a reply is <strong>never sent again automatically</strong>. Open the chat first. If the message is
                there, mark it resolved. If it is not, retry it and confirm that you checked. When the chat already shows a
                matching message from this number, retry is refused.
              </p>
            </HelpSection>
            <HelpSection title="Retry, resolve, close">
              <p>
                <strong>Retry</strong> queues the same message again: same text, same safety checks (automation switch, sending
                limits, group membership) at send time, and never a second copy. <strong>Resolve</strong> records that the customer
                was answered another way. <strong>Close</strong> records that it will not be sent, with a reason. Every action is
                kept in the reply&rsquo;s history with who did it.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      <div className="mb-3 flex flex-wrap gap-1.5">
        {chips.map((chip) => {
          const active = filters.state === chip.key;
          return (
            <Link
              key={chip.key}
              href={href({ state: chip.key === "open" ? null : chip.key, page: null })}
              className={`rounded-full px-3 py-1 text-[12px] font-medium ${active ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]" : "bg-[var(--color-neutral-bg)] text-[color:var(--color-muted-foreground)]"}`}
            >
              {chip.label}
              {chip.count !== null ? <span className="tabular ml-1 opacity-80">{chip.count.toLocaleString("en-US")}</span> : null}
            </Link>
          );
        })}
      </div>

      <form method="get">
        {filters.state !== "open" ? <input type="hidden" name="state" value={filters.state} /> : null}
        <FilterBar>
          {includeChannels ? (
            <Field label="Channel">
              <Select name="source" defaultValue={filters.source}>
                <option value="">All channels</option>
                <option value="WHATSAPP">WhatsApp</option>
                <option value="CHANNEL">Other channels</option>
              </Select>
            </Field>
          ) : null}
          {includeChannels ? (
            <Field label="Channel type">
              <Select name="channelType" defaultValue={filters.channelType}>
                <option value="">Any</option>
                <option value="WHATSAPP">WhatsApp</option>
                {CHANNEL_TYPES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="WhatsApp account">
            <Select name="accountId" defaultValue={filters.accountId}>
              <option value="">All accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Customer">
            <Input name="q" defaultValue={filters.q} placeholder="Group, name or number" />
          </Field>
          <Field label="Delivery">
            <Select name="uncertain" defaultValue={filters.uncertainOnly ? "1" : ""}>
              <option value="">Any</option>
              <option value="1">Uncertain only</option>
            </Select>
          </Field>
          <Field label="From">
            <Input name="dateFrom" type="date" defaultValue={filters.dateFrom} />
          </Field>
          <Field label="To">
            <Input name="dateTo" type="date" defaultValue={filters.dateTo} />
          </Field>
          {pageSize !== DEFAULT_PAGE_SIZE ? <input type="hidden" name="pageSize" value={pageSize} /> : null}
          <div className="flex gap-2">
            <Button type="submit">Apply</Button>
            <ButtonLink href={filters.state !== "open" ? `?state=${filters.state}` : "?"}>Reset</ButtonLink>
          </div>
        </FilterBar>
      </form>

      <p className="mb-2 text-[13px] text-[color:var(--color-muted-foreground)]">
        <span className="tabular font-semibold text-[color:var(--color-foreground)]">{total.toLocaleString("en-US")}</span> repl{total === 1 ? "y" : "ies"}
      </p>

      <FailedRepliesTable rows={rows} total={total} query={query} canWhatsApp={canWhatsApp} canChannels={canChannels} />

      {total > 0 ? (
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          buildHref={(p) => href({ page: p > 1 ? String(p) : null, pageSize: pageSize !== DEFAULT_PAGE_SIZE ? String(pageSize) : null })}
          pageSizeOptions={[...FAILED_REPLY_PAGE_SIZES]}
          buildPageSizeHref={(size) => href({ page: null, pageSize: size !== DEFAULT_PAGE_SIZE ? String(size) : null })}
          sticky
        />
      ) : null}
    </div>
  );
}
