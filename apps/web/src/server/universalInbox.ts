import { ALL_PROJECTS_SCOPE, EMPTY_INBOX_FILTERS, inboxFilterKey, orderInboxItems, type InboxFilterSet, type InboxScope } from "@support-automation/shared";
import type { Session } from "@/server/auth";
import { checkPermission } from "@/server/authorize";
import { inboxFilterOptions, loadInbox, type InboxCounts, type InboxItem, type InboxResult } from "@/server/channels/inbox";
import { mentionablePeople } from "@/server/inboxWorkspace";
import { accessibleProjects, runWithProject, type ActiveProject } from "@/server/projectContext";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { hasPermission } from "@/server/permissions";
import type { InboxOptions } from "@/app/p/[project]/(dashboard)/conversations/InboxWorkspace";

/**
 * The All projects inbox (ALL_PROJECTS_INBOX.md): one list of every conversation a person can already read, across the
 * projects they can enter. It adds no authority and no second query. For each project it enters that project and asks the
 * ordinary inbox, under the ordinary checks, so a row can only appear for somebody who could open it in its own project.
 * Opening a row goes to that project's own conversation page, so replies and changes are checked there as always.
 */

export interface UniversalItem extends InboxItem {
  projectSlug: string;
}

export interface UniversalProjectView {
  slug: string;
  name: string;
  status: string;
  /** Which of the chart colours marks this project, stable while the project list is. */
  colorIndex: number;
  counts: InboxCounts;
  lastMessageAt: string | null;
  /** Conversations in the list whose newest reply did not go out, or which cannot be replied to. */
  problems: number;
  options: InboxOptions;
}

export interface UniversalInboxResult {
  items: UniversalItem[];
  counts: InboxCounts;
  truncated: boolean;
  projects: UniversalProjectView[];
  /** Projects that could not be read this time, by name. Their conversations are simply missing until the next refresh. */
  unavailable: string[];
}

/** Several projects at once, within a process's database pool. */
const PARALLEL_PROJECTS = 3;
/** The whole list is rendered, so it is bounded, after the newest of every project have been merged. */
const UNIVERSAL_LIMIT = 600;
/** An inbox refreshes on every change in any project; a burst of messages is one reading. */
const READING_TTL_MS = 2_000;
const MAX_READINGS = 200;

interface Reading {
  at: number;
  value: Promise<InboxResult>;
}
const readings = new Map<string, Reading>();

/** After a person changes something, their next look must not show what they just changed the old way. */
export function forgetUniversalReadings(viewerId: string): void {
  for (const key of readings.keys()) if (key.startsWith(`${viewerId}|`)) readings.delete(key);
}

async function inBatches<T, R>(rows: readonly T[], work: (row: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let at = 0; at < rows.length; at += PARALLEL_PROJECTS) {
    out.push(...(await Promise.all(rows.slice(at, at + PARALLEL_PROJECTS).map((row, i) => work(row, at + i)))));
  }
  return out;
}

/**
 * The projects this inbox reads for this person: may enter it, the inbox module is on there, and they may read its
 * conversations there (their role, access level and project-role pages, by the one check every page uses).
 */
export async function universalInboxProjects(session: Session): Promise<ActiveProject[]> {
  const projects = await accessibleProjects(session.userId);
  const allowed = await inBatches(projects, (project) =>
    runWithProject(project, async () => {
      const access = await checkPermission("messages.view", { feature: "OMNICHANNEL", sections: ["/conversations/all"] });
      return "denied" in access ? null : project;
    }),
  );
  return allowed.filter((p): p is ActiveProject => p !== null);
}

function readProject(session: Session, project: ActiveProject, channel: InboxScope, filters: InboxFilterSet, now: Date): Promise<InboxResult> {
  const key = `${session.userId}|${project.id}|${channel}|${inboxFilterKey(filters)}`;
  const known = readings.get(key);
  if (known && Date.now() - known.at < READING_TTL_MS) return known.value;
  const value = runWithProject(project, () => loadInbox({ scope: channel, filters, viewerId: session.userId, now }));
  readings.delete(key);
  readings.set(key, { at: Date.now(), value });
  if (readings.size > MAX_READINGS) {
    const oldest = readings.keys().next().value;
    if (oldest !== undefined) readings.delete(oldest);
  }
  value.catch(() => readings.delete(key));
  return value;
}

function sumCounts(all: readonly InboxCounts[]): InboxCounts {
  const total: InboxCounts = { all: 0, unread: 0, needsReply: 0, mine: 0, closed: 0, byChannel: { WHATSAPP: 0, MESSENGER: 0, INSTAGRAM: 0, TELEGRAM: 0, WEBCHAT: 0, WHATSAPP_CLOUD: 0 } };
  for (const c of all) {
    total.all += c.all;
    total.unread += c.unread;
    total.needsReply += c.needsReply;
    total.mine += c.mine;
    total.closed += c.closed;
    for (const [channel, n] of Object.entries(c.byChannel) as Array<[keyof InboxCounts["byChannel"], number]>) total.byChannel[channel] += n;
  }
  return total;
}

const NO_OPTIONS: InboxOptions = { teams: [], accounts: [], people: [], collaboration: false, lifecycle: false, moodDetection: false, autoRouting: false, canShare: false };

async function projectOptions(session: Session, project: ActiveProject): Promise<InboxOptions> {
  return runWithProject(project, async () => {
    const [filterOptions, people, disabled] = await Promise.all([inboxFilterOptions(), mentionablePeople(session), activeDisabledFeatures()]);
    const canShare = await hasPermission(session, "channels.manage");
    return {
      ...filterOptions,
      people: people.map((p) => ({ id: p.id, name: p.name })),
      collaboration: !disabled.has("INBOX_COLLABORATION"),
      lifecycle: !disabled.has("UNIFIED_INBOX_V3"),
      autoRouting: !disabled.has("UNIFIED_INBOX_V3") && !disabled.has("AUTO_ROUTING"),
      canShare,
    };
  });
}

/**
 * One merged list. A project that cannot be read this time is named rather than failing the whole page: one project's
 * trouble must not take everybody's conversations off the screen.
 */
export async function loadUniversalInbox(
  session: Session,
  opts: { channel?: InboxScope; filters?: InboxFilterSet; now?: Date; withOptions?: boolean } = {},
): Promise<UniversalInboxResult> {
  const channel = opts.channel ?? "all";
  const filters = opts.filters ?? EMPTY_INBOX_FILTERS;
  const now = opts.now ?? new Date();
  const projects = await universalInboxProjects(session);
  const read = await inBatches(projects, async (project, index) => {
    try {
      const [inbox, options] = await Promise.all([
        readProject(session, project, channel, filters, now),
        opts.withOptions ? projectOptions(session, project) : Promise.resolve(NO_OPTIONS),
      ]);
      return { project, index, inbox, options };
    } catch (err) {
      console.error("[universal-inbox] a project could not be read", (err as Error).name);
      return { project, index, inbox: null, options: NO_OPTIONS };
    }
  });

  const views: UniversalProjectView[] = [];
  const items: UniversalItem[] = [];
  const counts: InboxCounts[] = [];
  const unavailable: string[] = [];
  let truncated = false;
  for (const { project, index, inbox, options } of read) {
    if (!inbox) {
      unavailable.push(project.name);
      continue;
    }
    truncated ||= inbox.truncated;
    counts.push(inbox.counts);
    items.push(...inbox.items.map((item) => ({ ...item, href: universalItemPath(item.href), projectSlug: project.slug })));
    views.push({
      slug: project.slug,
      name: project.name,
      status: project.status,
      colorIndex: index % 6,
      counts: inbox.counts,
      lastMessageAt: inbox.items.reduce<string | null>((newest, i) => (i.lastMessageAt && (!newest || i.lastMessageAt > newest) ? i.lastMessageAt : newest), null),
      problems: inbox.items.filter((i) => i.lastSendFailed || i.connectionProblem).length,
      options,
    });
  }
  const ordered = orderInboxItems(items, filters.sort);
  return { items: ordered.slice(0, UNIVERSAL_LIMIT), counts: sumCounts(counts), truncated: truncated || ordered.length > UNIVERSAL_LIMIT, projects: views, unavailable };
}

/** The filters over every project: a Team or account says whose it is, and a person who is in two projects is listed once. */
export function mergeInboxOptions(projects: readonly UniversalProjectView[]): InboxOptions {
  const people = new Map<string, { id: string; name: string }>();
  for (const p of projects) for (const person of p.options.people) people.set(person.id, person);
  return {
    teams: projects.flatMap((p) => p.options.teams.map((t) => ({ id: t.id, name: `${p.name} · ${t.name}` }))),
    accounts: projects.flatMap((p) => p.options.accounts.map((a) => ({ key: a.key, label: `${p.name} · ${a.label}` }))),
    people: [...people.values()].sort((a, b) => a.name.localeCompare(b.name)),
    collaboration: projects.some((p) => p.options.collaboration),
    lifecycle: projects.some((p) => p.options.lifecycle),
    moodDetection: projects.some((p) => p.options.moodDetection),
    autoRouting: false,
    canShare: false,
  };
}

/** A row's own address inside the All projects inbox, whichever kind of conversation it is. */
export function universalItemPath(href: string): string {
  if (href.startsWith("/chat/account/")) return `/conversations/${ALL_PROJECTS_SCOPE}/w/${href.slice("/chat/account/".length)}`;
  return href.replace(/^\/conversations\/[^/]+\//, `/conversations/${ALL_PROJECTS_SCOPE}/`);
}
