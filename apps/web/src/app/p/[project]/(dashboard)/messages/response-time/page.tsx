import { formatResponseDuration } from "@support-automation/shared";
import { requireAccess } from "@/server/authorize";
import { AutoRefresh } from "@/components/AutoRefresh";
import Link from "@/components/ProjectLink";
import { Alert, Button, ButtonLink, Field, FilterBar, HelpButton, HelpSection, Input, PageHeader, Pagination, Select, StatTile } from "@/components/ui";
import {
  getSupportResponseFilterOptions,
  getSupportResponseSetup,
  listResponses,
  parseResponseFilters,
  RESPONSE_SORTS,
  SUPPORT_RESPONSE_PAGE_SIZES,
} from "@/server/supportResponse";
import { ResponseTimeTable } from "./ResponseTimeTable";

const DEFAULT_PAGE_SIZE = 50;

/**
 * Messages → Response Time (SUPPORT_RESPONSE.md): every wait a Support Team member answered — who
 * answered, when the customer first wrote, when Support replied and how long that took. One row per
 * answered episode, so a group answered twice today is two rows with two honest times rather than
 * "latest message → latest reply".
 */
export default async function ResponseTimePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireAccess("messages.view");
  const params = await searchParams;
  const filters = parseResponseFilters(params);
  const page = Math.max(1, Number(params.page ?? "1") || 1);
  const requested = Number(params.pageSize ?? DEFAULT_PAGE_SIZE);
  const pageSize = (SUPPORT_RESPONSE_PAGE_SIZES as readonly number[]).includes(requested) ? requested : DEFAULT_PAGE_SIZE;

  const [{ rows, total, averageSeconds, slowestSeconds }, setup, options] = await Promise.all([
    listResponses(filters, page, pageSize),
    getSupportResponseSetup(),
    getSupportResponseFilterOptions(),
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
    return `/messages/response-time${s ? `?${s}` : ""}`;
  };

  return (
    <div>
      <AutoRefresh intervalMs={15000} />
      <PageHeader
        title="Response Time"
        description="How long customers waited for a Support Team reply — one row per answered wait, with who answered."
        actions={
          <HelpButton moduleTitle="Response Time">
            <HelpSection title="How a response time is measured">
              <p>
                From the <strong>first</strong> customer message after the previous Support reply, to the
                <strong> first</strong> reply from a Support Team member. A customer who sent four messages before an
                answer waited once, from the first. A group answered at 10:15 and again at 11:20 is two rows, each timed
                from its own first message.
              </p>
            </HelpSection>
            <HelpSection title="Who counts as Support">
              <p>
                Members of the Teams chosen under Settings → Support Activity Setup, as they were at the moment they
                replied — moving somebody to another Team later does not change answers already recorded. Replies from
                another Team, the business number, a rule or the AI never count here.
              </p>
            </HelpSection>
            <HelpSection title="How this differs from the Team Report and Response SLA">
              <p>
                Those reports count any reply — including the business number — as an answer. This page asks the narrower
                question of how long the Support Team took, so its times can be longer. Both are correct for their own
                question; neither changes the other.
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
            .
          </Alert>
        </div>
      ) : null}

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile label="Responses" value={total.toLocaleString("en-US")} hint="Matching these filters" />
        <StatTile label="Average response" value={formatResponseDuration(averageSeconds === null ? null : Math.round(averageSeconds))} />
        <StatTile label="Slowest response" value={formatResponseDuration(slowestSeconds)} tone={slowestSeconds !== null && slowestSeconds >= 3600 ? "warning" : "neutral"} />
      </div>

      <form method="get">
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
          <Field label="Replied by">
            <Select name="memberId" defaultValue={filters.memberId}>
              <option value="">Anyone</option>
              {options.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Team">
            <Select name="teamId" defaultValue={filters.teamId}>
              <option value="">Any Support Team</option>
              {options.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Replied from">
            <Input name="dateFrom" type="date" defaultValue={filters.dateFrom} />
          </Field>
          <Field label="To">
            <Input name="dateTo" type="date" defaultValue={filters.dateTo} />
          </Field>
          <Field label="Response at least (min)">
            <Input name="minMinutes" type="number" min={0} defaultValue={filters.minMinutes ?? ""} className="w-24" />
          </Field>
          <Field label="At most (min)">
            <Input name="maxMinutes" type="number" min={0} defaultValue={filters.maxMinutes ?? ""} className="w-24" />
          </Field>
          <Field label="Sort">
            <Select name="sort" defaultValue={filters.sort}>
              {Object.entries(RESPONSE_SORTS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          {pageSize !== DEFAULT_PAGE_SIZE ? <input type="hidden" name="pageSize" value={pageSize} /> : null}
          <div className="flex gap-2">
            <Button type="submit">Apply</Button>
            <ButtonLink href="?">Reset</ButtonLink>
          </div>
        </FilterBar>
      </form>

      <ResponseTimeTable rows={rows} total={total} query={query} />

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
