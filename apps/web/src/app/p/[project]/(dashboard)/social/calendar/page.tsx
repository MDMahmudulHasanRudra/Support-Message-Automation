import { ChevronLeft, ChevronRight } from "lucide-react";
import { utcToZonedLocal, zonedDay, zonedLocalToUtc } from "@support-automation/shared";
import Link from "@/components/ProjectLink";
import { PageHeader } from "@/components/ui";
import { pageAccess } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { listSocialAccounts } from "@/server/social/accounts";
import { listCampaigns } from "@/server/social/library";
import { listCalendarPosts } from "@/server/social/posts";
import { displayZone, platformShort } from "../socialUi";
import { CalendarBoard, type CalendarDay, type CalendarItem } from "./CalendarBoard";

export const metadata = { title: "Social calendar" };

const VIEWS = ["month", "week", "day"] as const;
type View = (typeof VIEWS)[number];
const WEEKDAYS = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];

/** Day arithmetic on "YYYY-MM-DD" keys (calendar days, independent of any zone). */
function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}
function weekday(key: string): number {
  // 0 = Saturday … 6 = Friday (the week starts on Saturday here).
  const [y, m, d] = key.split("-").map(Number);
  return (new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 1) % 7;
}

/**
 * The content calendar (SOCIAL_STUDIO.md §Calendar): month, week and day views in a chosen time zone,
 * filtered by account and campaign, with drafts optionally shown. Posts are placed on their planned or
 * scheduled time (or when they were published).
 */
export default async function SocialCalendarPage({ searchParams }: { searchParams: Promise<{ view?: string; date?: string; tz?: string; account?: string; campaign?: string; drafts?: string }> }) {
  const { session, canManage: canPublish } = await pageAccess("social.view", "social.publish", "SOCIAL_STUDIO");
  const sp = await searchParams;
  const tz = displayZone(sp.tz);
  const view: View = (VIEWS as readonly string[]).includes(sp.view ?? "") ? (sp.view as View) : "month";
  const today = zonedDay(new Date(), tz);
  const anchor = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;

  let first: string;
  let count: number;
  let inRange: (key: string) => boolean;
  let prev: string;
  let next: string;
  let heading: string;
  if (view === "month") {
    const monthStart = `${anchor.slice(0, 7)}-01`;
    const nextMonth = addDays(monthStart, 32).slice(0, 7) + "-01";
    first = addDays(monthStart, -weekday(monthStart));
    const last = addDays(nextMonth, -1);
    count = Math.ceil((((Date.parse(last) - Date.parse(first)) / 86_400_000 + 1) / 7)) * 7;
    inRange = (k) => k.slice(0, 7) === anchor.slice(0, 7);
    prev = addDays(monthStart, -1);
    next = nextMonth;
    heading = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${monthStart}T00:00:00Z`));
  } else if (view === "week") {
    first = addDays(anchor, -weekday(anchor));
    count = 7;
    inRange = () => true;
    prev = addDays(first, -7);
    next = addDays(first, 7);
    heading = `Week of ${first}`;
  } else {
    first = anchor;
    count = 1;
    inRange = () => true;
    prev = addDays(anchor, -1);
    next = addDays(anchor, 1);
    heading = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${anchor}T00:00:00Z`));
  }
  const keys = Array.from({ length: count }, (_, i) => addDays(first, i));
  const from = zonedLocalToUtc(`${keys[0]}T00:00`, tz)!;
  const to = zonedLocalToUtc(`${addDays(keys.at(-1)!, 1)}T00:00`, tz)!;

  const [posts, accounts, campaigns, canCreate] = await Promise.all([
    listCalendarPosts({ from, to, accountId: sp.account || undefined, campaignId: sp.campaign || undefined, includeDrafts: sp.drafts === "1" }),
    listSocialAccounts({ includeRemoved: true }),
    listCampaigns({ includeArchived: true }),
    hasPermission(session, "social.edit"),
  ]);

  const days: CalendarDay[] = keys.map((k) => ({ key: k, label: view === "month" ? String(Number(k.slice(8))) : `${WEEKDAYS[weekday(k)]} ${Number(k.slice(8))}`, inRange: inRange(k), isToday: k === today }));
  const items: CalendarItem[] = posts
    .filter((p) => p.when)
    .map((p) => {
      const local = utcToZonedLocal(new Date(p.when!), tz);
      return {
        id: p.id,
        day: local.slice(0, 10),
        time: local.slice(11, 16),
        title: p.title ?? (p.excerpt.slice(0, 40) || "Untitled"),
        status: p.status,
        accounts: p.accounts.map((a) => `${platformShort(a.platform)}·${a.name}`).join(", "),
        color: p.campaign?.color ?? null,
        movable: p.status === "SCHEDULED" && p.accounts.every((a) => a.status === "DUE" || a.status === "CANCELLED"),
      };
    });

  const q = (over: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged = { view, date: anchor, tz: sp.tz, account: sp.account, campaign: sp.campaign, drafts: sp.drafts, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
    return `/social/calendar?${params}`;
  };

  return (
    <div>
      <PageHeader title="Calendar" description={`Everything planned, scheduled and published. Times in ${tz}. ${canPublish ? "Drag a scheduled post to another day to move it." : ""}`} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <Link href={q({ date: prev })} aria-label="Previous" className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-1.5">
            <ChevronLeft className="size-4" aria-hidden />
          </Link>
          <Link href={q({ date: today })} className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-2 py-1 text-sm">
            Today
          </Link>
          <Link href={q({ date: next })} aria-label="Next" className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-1.5">
            <ChevronRight className="size-4" aria-hidden />
          </Link>
        </div>
        <h2 className="text-base font-semibold">{heading}</h2>
        <div className="flex overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] text-sm">
          {VIEWS.map((v) => (
            <Link key={v} href={q({ view: v })} className={`px-3 py-1 capitalize ${v === view ? "bg-[var(--color-neutral-bg)] font-medium" : ""}`}>
              {v}
            </Link>
          ))}
        </div>
        <form method="get" className="ml-auto flex flex-wrap items-center gap-2 text-sm">
          <input type="hidden" name="view" value={view} />
          <input type="hidden" name="date" value={anchor} />
          <select name="account" defaultValue={sp.account ?? ""} aria-label="Account" className="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2">
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({platformShort(a.platform)})
              </option>
            ))}
          </select>
          <select name="campaign" defaultValue={sp.campaign ?? ""} aria-label="Campaign" className="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2">
            <option value="">All campaigns</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input name="tz" defaultValue={tz} aria-label="Time zone" className="h-9 w-36 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2" />
          <label className="flex items-center gap-1">
            <input type="checkbox" name="drafts" value="1" defaultChecked={sp.drafts === "1"} /> Drafts
          </label>
          <button type="submit" className="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3">
            Apply
          </button>
        </form>
      </div>
      {/* The weekday header scrolls WITH the grid: outside the scroll box it stayed screen-wide while the
          grid kept its minimum width, so on a phone each date sat under the wrong weekday. */}
      <div className="overflow-x-auto">
        <div className={view === "month" ? "min-w-[42rem]" : view === "week" ? "min-w-[48rem]" : ""}>
          {view === "month" ? (
            <div className="mb-1 grid grid-cols-7 text-center text-xs font-medium text-[color:var(--color-muted-foreground)]">
              {WEEKDAYS.map((d) => (
                <span key={d}>{d}</span>
              ))}
            </div>
          ) : null}
          <CalendarBoard days={days} items={items} columns={view === "day" ? 1 : 7} canPublish={canPublish} timezone={tz} canCreate={canCreate} />
        </div>
      </div>
    </div>
  );
}
