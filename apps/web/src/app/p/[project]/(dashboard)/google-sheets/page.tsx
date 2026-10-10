import { ExternalLink, FileSpreadsheet } from "lucide-react";
import Link from "@/components/ProjectLink";
import {
  ActiveFilters,
  Badge,
  ButtonLink,
  EmptyState,
  FilterBar,
  HelpButton,
  HelpSection,
  NoFilterResults,
  PageHeader,
  Pagination,
  SearchField,
  Table,
  Td,
  Th,
  ViewOnlyNotice,
  type ActiveFilter,
} from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/date";
import { pageAccess } from "@/server/authorize";
import { prisma } from "@/server/db";
import { googleOAuthConfig } from "@/server/google/oauth";
import { isSpreadsheetView, listSpreadsheets, type SpreadsheetRow, type SpreadsheetView } from "@/server/google/spreadsheets";
import { AccountFilter } from "../groups/AccountFilter";
import { MonitorButton } from "./MonitorButton";
import { RefreshSpreadsheetsButton } from "./RefreshSpreadsheetsButton";
import { ViewChip } from "./ViewChip";

export const metadata = { title: "Spreadsheets" };

const PAGE_SIZE_OPTIONS = [50, 100, 500] as const;
const DEFAULT_PAGE_SIZE = 50;

const VIEW_LABELS: Record<SpreadsheetView, string> = {
  all: "All",
  monitored: "Monitored",
  unmonitored: "Not monitored",
  unreachable: "No longer reachable",
};

interface Params {
  search?: string;
  accountId?: string;
  view?: string;
  page?: string;
  pageSize?: string;
}

/**
 * Google Sheets → Spreadsheets (GOOGLE_SHEETS.md, Phase 2): every spreadsheet the project's connected
 * Google accounts reach, from Drive METADATA. No sheet is opened to build this page, and nothing from
 * inside a sheet is stored.
 */
export default async function SpreadsheetsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { canManage } = await pageAccess("google_sheets.view", "google_sheets.manage", "GOOGLE_SHEETS");
  const params = await searchParams;
  const view: SpreadsheetView = isSpreadsheetView(params.view) ? params.view : "all";
  const search = (params.search ?? "").trim();
  const requestedSize = Number(params.pageSize ?? DEFAULT_PAGE_SIZE);
  const pageSize = (PAGE_SIZE_OPTIONS as readonly number[]).includes(requestedSize) ? requestedSize : DEFAULT_PAGE_SIZE;
  const page = Math.max(1, Number(params.page ?? "1") || 1);

  const accounts = await prisma.googleIntegrationAccount.findMany({
    select: { id: true, email: true, status: true },
    orderBy: { email: "asc" },
  });
  const accountId = accounts.some((a) => a.id === params.accountId) ? (params.accountId as string) : null;
  const { rows, total, counts } = await listSpreadsheets({ search, accountId, view, page, pageSize });
  const connected = accounts.filter((a) => a.status === "CONNECTED");
  const configured = googleOAuthConfig() !== null;

  const href = (next: Partial<{ search: string; accountId: string; view: SpreadsheetView; page: number; pageSize: number }>) => {
    const merged = { search, accountId: accountId ?? "", view, page: 1, pageSize, ...next };
    const qs = new URLSearchParams();
    if (merged.search) qs.set("search", merged.search);
    if (merged.accountId) qs.set("accountId", merged.accountId);
    if (merged.view !== "all") qs.set("view", merged.view);
    if (merged.page > 1) qs.set("page", String(merged.page));
    if (merged.pageSize !== DEFAULT_PAGE_SIZE) qs.set("pageSize", String(merged.pageSize));
    const query = qs.toString();
    return `/google-sheets${query ? `?${query}` : ""}`;
  };

  const activeFilters: ActiveFilter[] = [];
  if (search) activeFilters.push({ label: "Search", value: search, removeHref: href({ search: "" }) });
  if (accountId) activeFilters.push({ label: "Account", value: accounts.find((a) => a.id === accountId)?.email ?? "", removeHref: href({ accountId: "" }) });
  if (view !== "all") activeFilters.push({ label: "Showing", value: VIEW_LABELS[view], removeHref: href({ view: "all" }) });
  const clearAllHref = href({ search: "", accountId: "", view: "all" });

  return (
    <div>
      <PageHeader
        title="Spreadsheets"
        description="Every Google spreadsheet the connected Google accounts can reach. The list is read from Google Drive's file details — no spreadsheet is opened to build it."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canManage && configured && connected.length > 0 ? <RefreshSpreadsheetsButton /> : null}
            <HelpButton moduleTitle="Spreadsheets">
              <HelpSection title="Where the list comes from">
                <p>
                  Each connected Google account (Settings → Google Sheets → Google Accounts) is asked which spreadsheets it can see — its
                  own and the ones shared with it. Only names, dates, owners and sharing are read. A spreadsheet several accounts can see
                  is listed once, with every account that reaches it.
                </p>
              </HelpSection>
              <HelpSection title="Last modified">
                <p>
                  The time and person are Google&apos;s own record of the latest change to the whole file. They are shown for reference
                  only: the app never uses them to decide who did the work.
                </p>
              </HelpSection>
              <HelpSection title="Monitored">
                <p>
                  Monitoring marks the spreadsheets whose work the team&apos;s activity should be tracked on. Marking a sheet changes
                  nothing in Google, and the sheet stays exactly as shared there.
                </p>
              </HelpSection>
              <HelpSection title="No longer reachable">
                <p>
                  A spreadsheet that no connected account can see any more — it was deleted, unshared, or its account was disconnected.
                  It is kept in the list with its history, and comes back by itself if an account can see it again.
                </p>
              </HelpSection>
            </HelpButton>
          </div>
        }
      />

      {canManage ? null : <ViewOnlyNotice />}

      {accounts.length === 0 ? (
        <EmptyState icon={<FileSpreadsheet className="size-5" aria-hidden />}>
          No Google account is connected to this project yet.{" "}
          <Link href="/settings/google-sheets" className="font-medium text-[color:var(--color-accent)] hover:underline">
            Connect one in Settings → Google Sheets
          </Link>{" "}
          and its spreadsheets appear here.
        </EmptyState>
      ) : (
        <>
          <FilterBar>
            <SearchField
              placeholder="Search name or ID…"
              defaultValue={search}
              preserve={{ accountId: accountId ?? undefined, view: view === "all" ? undefined : view, pageSize: pageSize === DEFAULT_PAGE_SIZE ? undefined : String(pageSize) }}
            />
            <div className="w-full sm:w-72">
              <AccountFilter
                value={accountId ?? ""}
                options={[
                  { value: "", label: "All Google accounts", href: href({ accountId: "" }) },
                  ...accounts.map((a) => ({
                    value: a.id,
                    label: `${a.email}${a.status === "CONNECTED" ? "" : a.status === "NEEDS_RECONNECT" ? " · needs reconnecting" : " · disconnected"}`,
                    href: href({ accountId: a.id }),
                  })),
                ]}
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(VIEW_LABELS) as SpreadsheetView[]).map((key) => (
                <ViewChip key={key} href={href({ view: key })} active={view === key} label={`${VIEW_LABELS[key]} (${counts[key].toLocaleString("en-US")})`} />
              ))}
            </div>
          </FilterBar>

          <ActiveFilters
            filters={activeFilters}
            clearAllHref={clearAllHref}
            resultCount={total}
            totalCount={counts.all + counts.unreachable}
            noun={{ singular: "spreadsheet", plural: "spreadsheets" }}
          />

          {rows.length === 0 ? (
            activeFilters.length > 0 ? (
              <NoFilterResults clearAllHref={clearAllHref} filters={activeFilters}>
                No spreadsheets match these filters.
              </NoFilterResults>
            ) : (
              <EmptyState icon={<FileSpreadsheet className="size-5" aria-hidden />}>
                No spreadsheets yet.{" "}
                {canManage && connected.length > 0
                  ? "Press Refresh from Google to read the connected accounts' spreadsheets."
                  : "They appear once a connected account's spreadsheet list has been read."}
              </EmptyState>
            )
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th>Spreadsheet</Th>
                    <Th>Last modified</Th>
                    <Th>Google account</Th>
                    <Th>Members</Th>
                    <Th>Monitoring</Th>
                    <Th>
                      <span className="sr-only">Open</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <SpreadsheetTableRow key={row.id} row={row} canManage={canManage} />
                  ))}
                </tbody>
              </Table>
              <Pagination
                page={page}
                pageSize={pageSize}
                total={total}
                buildHref={(p) => href({ page: p })}
                pageSizeOptions={[...PAGE_SIZE_OPTIONS]}
                buildPageSizeHref={(size) => href({ pageSize: size })}
                sticky
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

function SpreadsheetTableRow({ row, canManage }: { row: SpreadsheetRow; canManage: boolean }) {
  return (
    <tr>
      <Td className="min-w-[13rem] max-w-[28rem]">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/google-sheets/${row.id}`} className="font-medium text-[color:var(--color-foreground)] [overflow-wrap:anywhere] hover:underline">
            {row.name}
          </Link>
          {row.sharedInGoogle ? <Badge color="blue">Shared</Badge> : null}
        </div>
        <p className="mt-0.5 font-mono text-[11px] text-[color:var(--color-subtle-foreground)] [overflow-wrap:anywhere]">{row.googleFileId}</p>
        {row.ownerEmail ? (
          <p className="mt-0.5 text-[12px] text-[color:var(--color-muted-foreground)]">Owner: {row.ownerName ?? row.ownerEmail}</p>
        ) : null}
      </Td>
      <Td className="whitespace-nowrap">
        {row.modifiedTime ? (
          <>
            <span title={formatDateTime(row.modifiedTime)}>{formatDate(row.modifiedTime)}</span>
            {row.lastModifiedByName || row.lastModifiedByEmail ? (
              <p className="text-[12px] text-[color:var(--color-muted-foreground)]">by {row.lastModifiedByName ?? row.lastModifiedByEmail} (Google)</p>
            ) : null}
          </>
        ) : (
          <span className="text-[color:var(--color-muted-foreground)]">—</span>
        )}
      </Td>
      <Td>
        {row.removedAt ? (
          <span className="text-[12px] text-[color:var(--color-muted-foreground)]">No longer reachable since {formatDate(row.removedAt)}</span>
        ) : (
          <ul className="space-y-0.5">
            {row.paths.map((path) => (
              <li key={path.accountId} className="text-[12px]">
                <span className="text-[color:var(--color-foreground)] [overflow-wrap:anywhere]">{path.email}</span>{" "}
                <span className="text-[color:var(--color-muted-foreground)]">· {path.canEdit ? "can edit" : "view only"}</span>
                {path.accountStatus !== "CONNECTED" ? (
                  <>
                    {" "}
                    <Badge color="yellow">{path.accountStatus === "NEEDS_RECONNECT" ? "Needs reconnecting" : "Disconnected"}</Badge>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Td>
      <Td className="min-w-[10rem]">
        <MemberSummary row={row} />
      </Td>
      <Td className="whitespace-nowrap">
        {canManage ? (
          // Keyed by the server's value, so a change made elsewhere resets the button's own state.
          <MonitorButton key={`${row.id}:${row.isMonitored}`} spreadsheetId={row.id} monitored={row.isMonitored} />
        ) : row.isMonitored ? (
          <Badge color="green" dot>
            Monitored
          </Badge>
        ) : (
          <span className="text-[12px] text-[color:var(--color-muted-foreground)]">Not monitored</span>
        )}
      </Td>
      <Td className="whitespace-nowrap text-right">
        {row.webViewLink ? (
          <ButtonLink href={row.webViewLink} variant="ghost" size="sm" target="_blank" rel="noopener noreferrer" aria-label={`Open ${row.name} in Google Sheets (new tab)`}>
            Open in Google Sheets
            <ExternalLink className="size-3.5" aria-hidden />
          </ButtonLink>
        ) : null}
      </Td>
    </tr>
  );
}

/** "Rudra (Lead), Borhan, Istiyak +1 · 1 monitor" — the people who work on it first, then who watches. */
function MemberSummary({ row }: { row: SpreadsheetRow }) {
  const workers = row.members.filter((m) => m.role !== "MONITOR");
  const monitors = row.members.length - workers.length;
  if (row.members.length === 0) {
    return (
      <Link href={`/google-sheets/${row.id}`} className="text-[12px] text-[color:var(--color-muted-foreground)] hover:underline">
        No members yet
      </Link>
    );
  }
  const shown = workers.slice(0, 3).map((m) => (m.role === "LEAD" ? `${m.name} (Lead)` : m.name));
  return (
    <Link href={`/google-sheets/${row.id}`} className="block text-[12px] text-[color:var(--color-foreground)] hover:underline">
      {shown.length > 0 ? shown.join(", ") : "No one working on it"}
      {workers.length > 3 ? ` +${workers.length - 3}` : ""}
      {monitors > 0 ? <span className="text-[color:var(--color-muted-foreground)]">{` · ${monitors} monitor${monitors === 1 ? "" : "s"}`}</span> : null}
    </Link>
  );
}
