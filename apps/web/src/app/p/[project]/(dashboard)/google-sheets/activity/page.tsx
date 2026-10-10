import { Activity } from "lucide-react";
import { ActiveFilters, Card, EmptyState, FilterBar, HelpButton, HelpSection, PageHeader, Pagination, SectionHeader, type ActiveFilter } from "@/components/ui";
import { getDhakaDayRange, type SheetActivityKind, type SheetActivitySource } from "@support-automation/shared";
import { pageAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { loginsForProject } from "@/server/projectLogins";
import { listActivity } from "@/server/google/activity";
import { listLiveSessions } from "@/server/google/sessions";
import { getGoogleSheetsSettings } from "@/server/google/settings";
import { AccountFilter } from "../../groups/AccountFilter";
import { ActivityTable } from "../ActivityTable";
import { LiveNow } from "../LiveNow";
import { ViewChip } from "../ViewChip";

export const metadata = { title: "Spreadsheet Activity" };

const PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

const SHOW = {
  all: { label: "Everything", kind: undefined, source: undefined },
  work: { label: "Work", kind: "WORK", source: undefined },
  view: { label: "Viewing", kind: "VIEW", source: undefined },
  google: { label: "In Google", kind: undefined, source: "EXTERNAL_GOOGLE" },
} as const satisfies Record<string, { label: string; kind: SheetActivityKind | undefined; source: SheetActivitySource | undefined }>;
type ShowKey = keyof typeof SHOW;

const WITHIN = { today: "Today", "7d": "Last 7 days", "30d": "Last 30 days" } as const;
type WithinKey = keyof typeof WITHIN;

interface Params {
  show?: string;
  within?: string;
  user?: string;
  sheet?: string;
  page?: string;
}

/**
 * Google Sheets → Activity (GOOGLE_SHEETS.md §6–§7, Phases 6–7): who has a spreadsheet open right
 * now, and the log of what was done — in the app (exact: person, tab, range) and in Google directly
 * (as far as Google says). Other people's work, so `google_sheets.monitor`.
 */
export default async function SpreadsheetActivityPage({ searchParams }: { searchParams: Promise<Params> }) {
  await pageAccess("google_sheets.monitor", "google_sheets.manage", "GOOGLE_SHEETS");
  const params = await searchParams;
  const show: ShowKey = params.show && params.show in SHOW ? (params.show as ShowKey) : "all";
  const within: WithinKey = params.within && params.within in WITHIN ? (params.within as WithinKey) : "7d";
  const page = Math.max(1, Number(params.page ?? "1") || 1);

  const [logins, settings, sheet] = await Promise.all([
    loginsForProject(),
    getGoogleSheetsSettings(),
    params.sheet ? prisma.googleSpreadsheet.findUnique({ where: { id: params.sheet }, select: { id: true, name: true } }) : Promise.resolve(null),
  ]);
  const userId = logins.some((l) => l.id === params.user) ? (params.user as string) : null;
  const today = getDhakaDayRange(new Date());
  const from = within === "today" ? today.start : new Date(today.start.getTime() - (within === "7d" ? 6 : 29) * DAY_MS);

  const [live, log] = await Promise.all([
    listLiveSessions(sheet ? { spreadsheetId: sheet.id } : {}),
    listActivity({ kind: SHOW[show].kind, source: SHOW[show].source, userId: userId ?? undefined, spreadsheetId: sheet?.id, from }, page, PAGE_SIZE),
  ]);

  const href = (next: Partial<{ show: ShowKey; within: WithinKey; user: string; sheet: string; page: number }>) => {
    const merged = { show, within, user: userId ?? "", sheet: sheet?.id ?? "", page: 1, ...next };
    const qs = new URLSearchParams();
    if (merged.show !== "all") qs.set("show", merged.show);
    if (merged.within !== "7d") qs.set("within", merged.within);
    if (merged.user) qs.set("user", merged.user);
    if (merged.sheet) qs.set("sheet", merged.sheet);
    if (merged.page > 1) qs.set("page", String(merged.page));
    const query = qs.toString();
    return `/google-sheets/activity${query ? `?${query}` : ""}`;
  };
  const filters: ActiveFilter[] = [];
  if (sheet) filters.push({ label: "Spreadsheet", value: sheet.name, removeHref: href({ sheet: "" }) });
  if (userId) filters.push({ label: "Person", value: logins.find((l) => l.id === userId)?.name ?? "", removeHref: href({ user: "" }) });
  if (show !== "all") filters.push({ label: "Showing", value: SHOW[show].label, removeHref: href({ show: "all" }) });

  return (
    <div>
      <PageHeader
        title="Spreadsheet activity"
        description="Who is working on which spreadsheet right now, and everything done to them — in the app, and in Google directly."
        actions={
          <HelpButton moduleTitle="Spreadsheet activity">
            <HelpSection title="Viewing and work">
              <p>
                Opening a spreadsheet, switching tab, refreshing and searching are viewing. Only a saved change is work. A monitor&apos;s time is always viewing.
              </p>
            </HelpSection>
            <HelpSection title="In the app and in Google">
              <p>
                Work done in the app is exact: the person signed in, the tab and the cells. A change made in Google directly is read from Google&apos;s own record for monitored
                spreadsheets: when it happened and, when Google says, which Google account made it — never which cells or for how long. It is credited to a person only
                through the Google account they linked as their own; otherwise it is listed as unattributed, with the reason.
              </p>
            </HelpSection>
            <HelpSection title="Google's record of the app's own changes">
              <p>Changes saved here also appear in Google&apos;s record under the connected account. They are linked to the change made in the app and never counted twice.</p>
            </HelpSection>
          </HelpButton>
        }
      />

      <Card className="mb-6">
        <SectionHeader title="Open right now" description={`In the app, with activity in the last ${settings.inactivityMinutes} minutes.`} />
        <LiveNow sessions={live} showSheet={!sheet} inactivityMinutes={settings.inactivityMinutes} />
      </Card>

      <FilterBar>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(SHOW) as ShowKey[]).map((key) => (
            <ViewChip key={key} href={href({ show: key })} active={show === key} label={SHOW[key].label} />
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(WITHIN) as WithinKey[]).map((key) => (
            <ViewChip key={key} href={href({ within: key })} active={within === key} label={WITHIN[key]} />
          ))}
        </div>
        <div className="w-full sm:w-64">
          <AccountFilter
            value={userId ?? ""}
            options={[{ value: "", label: "Everyone", href: href({ user: "" }) }, ...logins.map((l) => ({ value: l.id, label: `${l.name} (@${l.username})`, href: href({ user: l.id }) }))]}
          />
        </div>
      </FilterBar>
      <ActiveFilters filters={filters} clearAllHref={href({ show: "all", user: "", sheet: "" })} />

      {log.rows.length === 0 ? (
        <EmptyState icon={<Activity className="size-5" aria-hidden />}>Nothing recorded {WITHIN[within].toLowerCase()} with these filters.</EmptyState>
      ) : (
        <>
          <ActivityTable rows={log.rows} showSheet={!sheet} />
          <Pagination page={page} pageSize={PAGE_SIZE} total={log.total} buildHref={(p) => href({ page: p })} />
        </>
      )}
    </div>
  );
}
