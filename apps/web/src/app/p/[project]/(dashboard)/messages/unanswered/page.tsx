import { requireAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { AutoRefresh } from "@/components/AutoRefresh";
import Link from "@/components/ProjectLink";
import { Alert, Button, ButtonLink, Field, FilterBar, HelpButton, HelpSection, Input, PageHeader, Pagination, Select } from "@/components/ui";
import {
  getSupportResponseFilterOptions,
  getSupportResponseSetup,
  listUnanswered,
  parseUnansweredFilters,
  SUPPORT_RESPONSE_PAGE_SIZES,
  UNANSWERED_SORTS,
} from "@/server/supportResponse";
import { UnansweredTable } from "./UnansweredTable";

const DEFAULT_PAGE_SIZE = 50;
const WAITING_OPTIONS = [
  ["", "Any"],
  ["5", "5 min or more"],
  ["15", "15 min or more"],
  ["30", "30 min or more"],
  ["60", "1 hour or more"],
  ["240", "4 hours or more"],
  ["1440", "1 day or more"],
] as const;

/**
 * Messages → Unanswered Groups (SUPPORT_RESPONSE.md): every group where a customer has written and
 * no Support Team member has replied since — one row per group however many messages the customer
 * sent. Read from `SupportResponseEpisode`, which the worker keeps current as messages arrive; the
 * page only reads, and refreshes itself so a reply takes the group off the list without a reload.
 */
export default async function UnansweredGroupsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requireAccess("messages.view");
  const canClear = await hasPermission(session, "messages.reply");
  const params = await searchParams;
  const filters = parseUnansweredFilters(params);
  const page = Math.max(1, Number(params.page ?? "1") || 1);
  const requested = Number(params.pageSize ?? DEFAULT_PAGE_SIZE);
  const pageSize = (SUPPORT_RESPONSE_PAGE_SIZES as readonly number[]).includes(requested) ? requested : DEFAULT_PAGE_SIZE;
  const now = new Date();

  const [{ rows, total }, setup, options] = await Promise.all([listUnanswered(filters, page, pageSize, now), getSupportResponseSetup(), getSupportResponseFilterOptions()]);

  // The query the table hands back to the server for "select all matching", Clear all and export.
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) if (value && key !== "page" && key !== "pageSize") query[key] = value;
  const href = (overrides: Record<string, string | null>) => {
    const qs = new URLSearchParams(query);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null) qs.delete(k);
      else qs.set(k, v);
    }
    const s = qs.toString();
    return `/messages/unanswered${s ? `?${s}` : ""}`;
  };
  const showingCleared = filters.status === "CLEARED";

  return (
    <div>
      {/* A Support reply takes a group off this list; the page follows without a reload. */}
      <AutoRefresh intervalMs={15000} />
      <PageHeader
        title="Unanswered Groups"
        description="Groups where a customer is waiting and no Support Team member has replied yet — one row per group, longest waiting first."
        actions={
          <HelpButton moduleTitle="Unanswered Groups">
            <HelpSection title="What puts a group here">
              <p>
                A message from a customer — anyone who is not on the Team Members roster. Every further customer message
                adds to the same row; the wait is timed from the first one.
              </p>
            </HelpSection>
            <HelpSection title="What takes it off">
              <p>
                A reply from a member of the <strong>Support Team</strong> (the Teams chosen under Settings → Support
                Activity Setup), sent from their own WhatsApp. The group then moves to Response Time with who replied and
                how long it took.
              </p>
              <p>
                A reply from another Team, from the business number (the business phone or the dashboard chat), from a
                rule or from the AI does <strong>not</strong> count: WhatsApp does not say which person sent a
                business-number message, and the question here is how long the Support Team took.
              </p>
            </HelpSection>
            <HelpSection title="Clear">
              <p>
                Clearing dismisses the current wait only. No message, group or chat history is deleted and nothing changes
                in WhatsApp. When the customer writes again, the group comes back as a new wait. Cleared groups stay
                listed under &ldquo;Cleared&rdquo; with who cleared them and why.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      {setup.teams.length === 0 ? (
        <div className="mb-4">
          <Alert tone="warning" title="Choose the Support Team to start tracking">
            Nothing is tracked until the Support Team is chosen under{" "}
            <Link href="/support-activity/settings" className="underline">
              Settings → Support Activity Setup
            </Link>
            . Tracking starts with the next message after that; earlier history is not reprocessed.
          </Alert>
        </div>
      ) : (
        <p className="mb-3 text-[12px] text-[color:var(--color-muted-foreground)]">
          Support Team: <strong className="font-medium text-[color:var(--color-foreground)]">{setup.teams.map((t) => t.name).join(", ")}</strong>
        </p>
      )}

      <div className="mb-3 flex gap-1.5">
        <Link
          href={href({ status: null, page: null })}
          className={`rounded-full px-3 py-1 text-[12px] font-medium ${!showingCleared ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]" : "bg-[var(--color-neutral-bg)] text-[color:var(--color-muted-foreground)]"}`}
        >
          Unanswered
        </Link>
        <Link
          href={href({ status: "CLEARED", page: null })}
          className={`rounded-full px-3 py-1 text-[12px] font-medium ${showingCleared ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]" : "bg-[var(--color-neutral-bg)] text-[color:var(--color-muted-foreground)]"}`}
        >
          Cleared
        </Link>
      </div>

      <form method="get">
        {showingCleared ? <input type="hidden" name="status" value="CLEARED" /> : null}
        <FilterBar>
          <Field label="Account">
            <Select name="accountId" defaultValue={filters.accountId}>
              <option value="">All accounts</option>
              {options.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Group">
            <Input name="group" defaultValue={filters.group} placeholder="Name contains" />
          </Field>
          <Field label="Sender">
            <Input name="sender" defaultValue={filters.sender} placeholder="Latest sender" />
          </Field>
          <Field label="Waiting">
            <Select name="waitingMin" defaultValue={filters.waitingMin === null ? "" : String(filters.waitingMin)}>
              {WAITING_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Messages at least">
            <Input name="minMessages" type="number" min={1} defaultValue={filters.minMessages ?? ""} className="w-24" />
          </Field>
          <Field label="From">
            <Input name="dateFrom" type="date" defaultValue={filters.dateFrom} />
          </Field>
          <Field label="To">
            <Input name="dateTo" type="date" defaultValue={filters.dateTo} />
          </Field>
          <Field label="Sort">
            <Select name="sort" defaultValue={filters.sort}>
              {Object.entries(UNANSWERED_SORTS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          {pageSize !== DEFAULT_PAGE_SIZE ? <input type="hidden" name="pageSize" value={pageSize} /> : null}
          <div className="flex gap-2">
            <Button type="submit">Apply</Button>
            <ButtonLink href={showingCleared ? "?status=CLEARED" : "?"}>Reset</ButtonLink>
          </div>
        </FilterBar>
      </form>

      <p className="mb-2 text-[13px] text-[color:var(--color-muted-foreground)]">
        <span className="tabular font-semibold text-[color:var(--color-foreground)]">{total.toLocaleString("en-US")}</span>{" "}
        {showingCleared ? "cleared" : "unanswered"} group{total === 1 ? "" : "s"}
      </p>

      <UnansweredTable rows={rows} total={total} query={query} nowMs={now.getTime()} canClear={canClear} showingCleared={showingCleared} />

      {total > 0 ? (
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          buildHref={(p) => href({ page: p > 1 ? String(p) : null, pageSize: pageSize !== DEFAULT_PAGE_SIZE ? String(pageSize) : null })}
          pageSizeOptions={[...SUPPORT_RESPONSE_PAGE_SIZES]}
          buildPageSizeHref={(size) => href({ page: null, pageSize: size !== DEFAULT_PAGE_SIZE ? String(size) : null })}
          sticky
        />
      ) : null}
    </div>
  );
}
