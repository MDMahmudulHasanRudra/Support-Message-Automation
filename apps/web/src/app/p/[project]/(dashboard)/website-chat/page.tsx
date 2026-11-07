import { Bot, Clock3, Globe, Hourglass, MessagesSquare, PhoneCall, Sparkles, Timer, UserRoundCheck, UsersRound, Video } from "lucide-react";
import { Badge, type BadgeColor, ButtonLink, Card, EmptyState, HeroKpi, PageHeader, SectionHeader, Select, StatTile, Table, Td, Th } from "@/components/ui";
import { ChartCard, ColumnChart } from "@/components/charts";
import Link from "@/components/ProjectLink";
import { LiveRefresh } from "@/components/LiveRefresh";
import { PushPrompt } from "@/components/pwa/PushPrompt";
import { pageAccess } from "@/server/authorize";
import { loadWebsiteChatBoard, type QueueRow } from "@/server/websiteChat";
import { formatDurationShort } from "@/lib/duration";
import { AutoSubmitForm } from "../clients/AutoSubmitForm";
import { ChipTabs, type Chip } from "../clients/ModuleKit";
import { TakeConversationButton } from "./TakeConversationButton";

export const metadata = { title: "Website Chat" };
export const dynamic = "force-dynamic";

const STATE: Record<QueueRow["state"], { label: string; color: BadgeColor }> = {
  WAITING_PERSON: { label: "Waiting for a person", color: "red" },
  AI_ANSWERING: { label: "AI is answering", color: "blue" },
  AI_ANSWERED: { label: "Answered by AI", color: "green" },
  TEAM_ANSWERED: { label: "Answered by team", color: "green" },
  NO_MESSAGE: { label: "No message yet", color: "gray" },
};

const VIEWS: Array<{ key: string; label: string; match: (r: QueueRow) => boolean; tone?: Chip["tone"] }> = [
  { key: "waiting", label: "Waiting for a person", match: (r) => r.state === "WAITING_PERSON", tone: "danger" },
  { key: "ai", label: "AI is answering", match: (r) => r.state === "AI_ANSWERING" },
  { key: "aiAnswered", label: "Answered by AI", match: (r) => r.state === "AI_ANSWERED" },
  { key: "team", label: "Answered by team", match: (r) => r.state === "TEAM_ANSWERED" },
  { key: "unassigned", label: "Nobody assigned", match: (r) => !r.assigneeId },
  { key: "all", label: "All open", match: () => true },
];

/** A live wait: seconds matter here, in a way they do not on a report. */
const waitText = (seconds: number) => (seconds < 60 ? "Under a minute" : formatDurationShort(seconds));

const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? u.host : `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
};

/**
 * The Live board (WEBSITE_CHAT.md): who is waiting and for how long, what AI is taking care of, who holds what, and
 * who is on the website now. Refreshed as soon as something changes.
 */
export default async function WebsiteChatBoardPage({ searchParams }: { searchParams: Promise<{ view?: string; widget?: string }> }) {
  const { canManage } = await pageAccess("messages.view", "conversations.reply", "OMNICHANNEL");
  const query = await searchParams;
  const widgetId = query.widget || null;
  const board = await loadWebsiteChatBoard(new Date(), widgetId);
  const view = VIEWS.find((v) => v.key === query.view) ?? VIEWS[0]!;
  const rows = board.rows.filter(view.match).slice(0, 100);
  const href = (key: string) => `/website-chat?view=${key}${widgetId ? `&widget=${widgetId}` : ""}`;
  const chips: Chip[] = VIEWS.map((v) => ({ key: v.key, label: v.label, href: href(v.key), active: v.key === view.key, tone: v.tone, count: board.rows.filter(v.match).length }));
  const { today, counts, presence } = board;

  if (board.widgets.length === 0) {
    return (
      <div>
        <PageHeader title="Website Chat" description="A chat box for your website: visitors tell you who they are, then talk to AI or your team, and it all lands here." />
        <Card>
          <div className="mx-auto max-w-md py-8 text-center">
            <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-[var(--color-accent-bg)] text-[color:var(--color-accent-fg)]">
              <Globe className="size-6" aria-hidden />
            </span>
            <h2 className="mt-4 text-lg font-semibold">Put a chat box on your website</h2>
            <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">Create a widget and paste one line of code into any website. It takes about a minute.</p>
            <ButtonLink href="/website-chat/widgets/new" variant="primary" className="mt-4">
              Create your first widget
            </ButtonLink>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <LiveRefresh intervalMs={4000} />
      <PushPrompt />
      <PageHeader
        title="Website Chat"
        description="Who is waiting, what AI is taking care of, and who is on your website now. This page updates by itself."
        actions={
          <>
            {board.widgets.length > 1 ? (
              <AutoSubmitForm>
                <input type="hidden" name="view" value={view.key} />
                <Select name="widget" defaultValue={widgetId ?? ""} aria-label="Website" className="w-52">
                  <option value="">All websites</option>
                  {board.widgets.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              </AutoSubmitForm>
            ) : null}
            <ButtonLink href="/conversations/website" variant="primary">
              <MessagesSquare className="size-4" aria-hidden />
              Open conversations
            </ButtonLink>
          </>
        }
      />

      <div className="mb-3.5 grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <HeroKpi label="Waiting for a person" value={counts.waiting} icon={Hourglass} tone={counts.waiting ? "amber" : "tide"} sub={board.longestWait !== null ? `Longest wait: ${waitText(board.longestWait)}` : "Nobody is waiting"} href={href("waiting")} />
        <HeroKpi label="Taken care of by AI" value={counts.ai + counts.aiAnswered} icon={Bot} tone="sea" sub={`${counts.ai} being answered now`} href={href("aiAnswered")} />
        <HeroKpi label="Answered by your team" value={counts.team} icon={UserRoundCheck} tone="tide" sub={`${counts.unassigned} open with nobody assigned`} href={href("team")} />
        <HeroKpi label="On your website now" value={presence.online} icon={Globe} tone="navy" sub={presence.chatting ? `${presence.chatting} of them have chatted with you` : "Visitors with the page open"} />
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3.5 lg:grid-cols-5">
        <StatTile icon={Sparkles} tone="accent" label="New chats today" value={today.newChats} hint={`${today.customerMessages} customer messages`} />
        <StatTile icon={Timer} label="First reply today" value={today.medianFirstReply === null ? "—" : waitText(Math.round(today.medianFirstReply))} hint="Median, AI or a person" />
        <StatTile icon={Clock3} label="A person's first reply" value={today.medianFirstHumanReply === null ? "—" : waitText(Math.round(today.medianFirstHumanReply))} hint="Median today" />
        <StatTile icon={Bot} label="Replies today" value={`${today.aiReplies} / ${today.teamReplies}`} hint="AI / your team" />
        <StatTile icon={UsersRound} label="Contact details today" value={`${today.visitorsWithContact} / ${today.visitors}`} hint="Visitors who left a phone or email" href="/website-chat/visitors" />
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="min-w-0">
          <SectionHeader title="Open conversations" description="Longest wait first: the top one is who to answer next." />
          <ChipTabs label="Conversation views" chips={chips} />
          <div className="mt-2.5">
            {rows.length === 0 ? (
              <EmptyState>{view.key === "waiting" ? "Nobody is waiting for a person right now." : "Nothing here right now."}</EmptyState>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Visitor</Th>
                    <Th>Status</Th>
                    <Th>Message</Th>
                    <Th>{null}</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <Td className="max-w-56">
                        <Link href={`/conversations/website/c/${r.id}`} className="block truncate font-medium hover:underline">
                          {r.name}
                        </Link>
                        <p className="truncate text-xs text-[color:var(--color-muted-foreground)]">{r.phone ? `+${r.phone}` : (r.email ?? "No contact details")}</p>
                        <p className="truncate text-xs text-[color:var(--color-subtle-foreground)]" title={r.pageUrl ?? undefined}>
                          {r.pageUrl ? pathOf(r.pageUrl) : r.widget}
                        </p>
                      </Td>
                      <Td>
                        <Badge color={STATE[r.state].color} dot>
                          {STATE[r.state].label}
                        </Badge>
                        {r.waitSeconds !== null ? <p className={`mt-1 whitespace-nowrap text-xs tabular-nums ${r.state === "WAITING_PERSON" ? "font-semibold text-[color:var(--color-danger-fg)]" : "text-[color:var(--color-muted-foreground)]"}`}>Waiting: {waitText(r.waitSeconds)}</p> : null}
                        <p className="mt-0.5 whitespace-nowrap text-xs text-[color:var(--color-muted-foreground)]">{r.assignee ? `With ${r.assignee}` : "Nobody assigned"}</p>
                      </Td>
                      <Td className="max-w-52">
                        <span className="line-clamp-2 text-[color:var(--color-muted-foreground)]" title={r.preview ?? undefined}>
                          {r.preview ?? "—"}
                        </span>
                      </Td>
                                            <Td>
                        <div className="flex items-center justify-end gap-1.5">
                          {!r.assigneeId && canManage ? <TakeConversationButton id={r.id} /> : null}
                          <ButtonLink href={`/conversations/website/c/${r.id}`} variant="secondary" size="sm">
                            Open
                          </ButtonLink>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        </section>

        <aside className="space-y-3.5">
          <Card>
            <h2 className="text-sm font-semibold">Team load</h2>
            {board.team.length === 0 ? (
              <p className="mt-1.5 text-xs text-[color:var(--color-muted-foreground)]">No conversation is assigned to anyone yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-[var(--color-border)]">
                {board.team.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 py-2 text-[13px]">
                    <span className="truncate font-medium">{t.name}</span>
                    <span className="shrink-0 tabular-nums text-[color:var(--color-muted-foreground)]">
                      {t.open} open{t.waiting ? <span className="ml-1.5 font-semibold text-[color:var(--color-danger-fg)]">{t.waiting} waiting</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <h2 className="text-sm font-semibold">Pages open now</h2>
            {presence.pages.length === 0 ? (
              <p className="mt-1.5 text-xs text-[color:var(--color-muted-foreground)]">Nobody is on your website at the moment, or the count is switched off for this widget.</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {presence.pages.map((p) => (
                  <li key={p.page} className="flex items-center justify-between gap-2 text-[13px]">
                    <span className="truncate" title={p.page}>
                      {pathOf(p.page)}
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums">{p.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <ChartCard title="New chats" description="Last 14 days">
            <ColumnChart data={board.byDay.map((d) => ({ label: d.day.slice(5), value: d.chats }))} ariaLabel="New website chats per day, last 14 days" unitLabel="chats" labelEvery={3} height={110} />
          </ChartCard>
          <Card>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Voice and video calls</h2>
              <Badge color="yellow">Coming soon</Badge>
            </div>
            <p className="mt-1.5 text-xs text-[color:var(--color-muted-foreground)]">One-to-one calls with a website visitor, right from the chat. Not available yet.</p>
            <div className="mt-2.5 flex gap-2 text-[color:var(--color-subtle-foreground)]">
              <PhoneCall className="size-4" aria-hidden />
              <Video className="size-4" aria-hidden />
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
