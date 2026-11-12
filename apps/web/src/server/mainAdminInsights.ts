import { isProjectStatus, PROJECT_STATUS_LABELS } from "@support-automation/shared";
import { platformPrisma } from "@/server/db";

/**
 * The Main Admin dashboard's charts (the Premium Tide Board, apps/web/DESIGN.md): traffic in and out, when
 * customers write, where they write, how much AI answered, the open work and the people. Every figure adds up
 * only the projects the caller passes, which are the ones this person can enter, and counts rows the project's
 * own pages also show. Nothing here is a new definition, and nothing is ever billing or plans.
 *
 * Every raw query names "projectId" (rawSqlProjectFilter.test.ts) and converts instants to Dhaka days the
 * two-step way (`AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka'`), since the columns hold UTC without a zone.
 */

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 14;
const HEAT_DAYS = 28;

export interface TrafficDay {
  label: string;
  incoming: number;
  outgoing: number;
}

export interface AdminInsights {
  /** Messages per Dhaka day, WhatsApp and the other channels together, oldest first. */
  traffic: TrafficDay[];
  totals: { incoming: number; outgoing: number; previousIncoming: number };
  /** Incoming messages per day for each project, oldest first, for the table's sparkline. */
  perProject: Record<string, number[]>;
  /** Incoming messages by weekday (Sunday first) and hour, Dhaka time, over four weeks. */
  heat: number[][];
  heatTotal: number;
  /** Incoming messages per channel over the window. */
  channels: Array<{ key: string; value: number }>;
  ai: { answered: number; handedOver: number };
  workload: { openTickets: number; followUpsDue: number; clients: number; contacts: number; channelConnections: number };
}

const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" });
const dayLabel = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Dhaka", month: "short", day: "numeric" });

export async function getAdminInsights(projectIds: string[], nowMs: number): Promise<AdminInsights> {
  const days = Array.from({ length: WINDOW_DAYS }, (_, i) => new Date(nowMs - (WINDOW_DAYS - 1 - i) * DAY_MS));
  const keys = days.map((d) => dayKey.format(d));
  const empty: AdminInsights = {
    traffic: days.map((d) => ({ label: dayLabel.format(d), incoming: 0, outgoing: 0 })),
    totals: { incoming: 0, outgoing: 0, previousIncoming: 0 },
    perProject: {},
    heat: Array.from({ length: 7 }, () => Array<number>(24).fill(0)),
    heatTotal: 0,
    channels: [],
    ai: { answered: 0, handedOver: 0 },
    workload: { openTickets: 0, followUpsDue: 0, clients: 0, contacts: 0, channelConnections: 0 },
  };
  if (projectIds.length === 0) return empty;

  const since = new Date(nowMs - WINDOW_DAYS * DAY_MS);
  const previousSince = new Date(nowMs - 2 * WINDOW_DAYS * DAY_MS);
  const heatSince = new Date(nowMs - HEAT_DAYS * DAY_MS);
  const inProjects = { projectId: { in: projectIds } };

  const [whatsapp, channel, previous, heatRows, aiRows, openTickets, followUpsDue, clients, contacts, channelConnections] = await Promise.all([
    platformPrisma.$queryRaw<Array<{ projectId: string; day: string; direction: string; count: bigint }>>`
      SELECT "projectId", to_char(("timestampWa" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka')::date, 'YYYY-MM-DD') AS day, direction::text AS direction, count(*)::bigint AS count
      FROM "Message"
      WHERE "projectId" = ANY(${projectIds}) AND "timestampWa" >= ${since}
      GROUP BY 1, 2, 3`,
    platformPrisma.$queryRaw<Array<{ projectId: string; day: string; type: string; direction: string; count: bigint }>>`
      SELECT "projectId", to_char(("occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka')::date, 'YYYY-MM-DD') AS day, type::text AS type, direction::text AS direction, count(*)::bigint AS count
      FROM "ChannelMessage"
      WHERE "projectId" = ANY(${projectIds}) AND "occurredAt" >= ${since}
      GROUP BY 1, 2, 3, 4`,
    platformPrisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT (
        (SELECT count(*) FROM "Message" WHERE "projectId" = ANY(${projectIds}) AND direction = 'INCOMING' AND "timestampWa" >= ${previousSince} AND "timestampWa" < ${since})
        + (SELECT count(*) FROM "ChannelMessage" WHERE "projectId" = ANY(${projectIds}) AND direction = 'INBOUND' AND "occurredAt" >= ${previousSince} AND "occurredAt" < ${since})
      )::bigint AS count`,
    platformPrisma.$queryRaw<Array<{ dow: number; hour: number; count: bigint }>>`
      SELECT dow, hour, sum(count)::bigint AS count FROM (
        SELECT extract(dow FROM ("timestampWa" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka'))::int AS dow,
               extract(hour FROM ("timestampWa" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka'))::int AS hour, count(*) AS count
        FROM "Message"
        WHERE "projectId" = ANY(${projectIds}) AND direction = 'INCOMING' AND "timestampWa" >= ${heatSince}
        GROUP BY 1, 2
        UNION ALL
        SELECT extract(dow FROM ("occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka'))::int AS dow,
               extract(hour FROM ("occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka'))::int AS hour, count(*) AS count
        FROM "ChannelMessage"
        WHERE "projectId" = ANY(${projectIds}) AND direction = 'INBOUND' AND "occurredAt" >= ${heatSince}
        GROUP BY 1, 2
      ) AS both_kinds
      GROUP BY 1, 2`,
    platformPrisma.aiFallbackDecision.groupBy({ by: ["outcome"], where: { ...inProjects, createdAt: { gte: since } }, _count: { _all: true } }),
    platformPrisma.ticket.count({ where: { ...inProjects, status: { in: ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER"] } } }),
    platformPrisma.followUp.count({ where: { ...inProjects, status: "OPEN", dueAt: { lte: new Date(nowMs) } } }),
    platformPrisma.client.count({ where: { ...inProjects, archivedAt: null } }),
    platformPrisma.contact.count({ where: inProjects }),
    platformPrisma.channelConnection.count({ where: { ...inProjects, status: "CONNECTED" } }),
  ]);

  const index = new Map(keys.map((k, i) => [k, i]));
  const traffic = empty.traffic.map((d) => ({ ...d }));
  const perProject: Record<string, number[]> = Object.fromEntries(projectIds.map((id) => [id, Array<number>(WINDOW_DAYS).fill(0)]));
  const channelTotals = new Map<string, number>();
  const bump = (projectId: string, day: string, incoming: boolean, count: number, channelKey: string) => {
    const i = index.get(day);
    if (i === undefined) return;
    if (incoming) {
      traffic[i]!.incoming += count;
      (perProject[projectId] ??= Array<number>(WINDOW_DAYS).fill(0))[i]! += count;
      channelTotals.set(channelKey, (channelTotals.get(channelKey) ?? 0) + count);
    } else traffic[i]!.outgoing += count;
  };
  for (const r of whatsapp) bump(r.projectId, r.day, r.direction === "INCOMING", Number(r.count), "WHATSAPP");
  for (const r of channel) bump(r.projectId, r.day, r.direction === "INBOUND", Number(r.count), r.type);

  const heat = empty.heat.map((row) => [...row]);
  let heatTotal = 0;
  for (const r of heatRows) {
    const n = Number(r.count);
    if (r.dow >= 0 && r.dow < 7 && r.hour >= 0 && r.hour < 24) {
      heat[r.dow]![r.hour]! += n;
      heatTotal += n;
    }
  }
  const aiCount = (outcome: string) => aiRows.find((r) => r.outcome === outcome)?._count._all ?? 0;

  return {
    traffic,
    totals: {
      incoming: traffic.reduce((sum, d) => sum + d.incoming, 0),
      outgoing: traffic.reduce((sum, d) => sum + d.outgoing, 0),
      previousIncoming: Number(previous[0]?.count ?? 0),
    },
    perProject,
    heat,
    heatTotal,
    channels: [...channelTotals].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value),
    ai: { answered: aiCount("AI_REPLIED"), handedOver: aiCount("HUMAN_FALLBACK") },
    workload: { openTickets, followUpsDue, clients, contacts, channelConnections },
  };
}

export interface AdminPeople {
  logins: number;
  activeLogins: number;
  signedInThisWeek: number;
  employees: number;
  employeesWithLogin: number;
  byRole: Array<{ id: string; label: string; value: number }>;
  byDepartment: Array<{ id: string; label: string; value: number }>;
}

/** The organisation's people: logins, roles, employees and departments. Platform data, the customer's own. */
export async function getAdminPeople(nowMs: number): Promise<AdminPeople> {
  const [users, employees, departments] = await Promise.all([
    platformPrisma.user.findMany({ where: { supportOperatorId: null }, select: { isActive: true, lastLoginAt: true, permissionModule: { select: { id: true, name: true } } } }),
    platformPrisma.employee.findMany({ where: { status: "ACTIVE" }, select: { userId: true, departmentId: true } }),
    platformPrisma.department.findMany({ select: { id: true, name: true } }),
  ]);
  const weekAgo = nowMs - 7 * DAY_MS;
  const roles = new Map<string, { id: string; label: string; value: number }>();
  for (const u of users.filter((x) => x.isActive)) {
    const id = u.permissionModule?.id ?? "none";
    const row = roles.get(id) ?? { id, label: u.permissionModule?.name ?? "No role", value: 0 };
    row.value += 1;
    roles.set(id, row);
  }
  const names = new Map(departments.map((d) => [d.id, d.name]));
  const byDept = new Map<string, number>();
  for (const e of employees) byDept.set(e.departmentId ?? "none", (byDept.get(e.departmentId ?? "none") ?? 0) + 1);
  return {
    logins: users.length,
    activeLogins: users.filter((u) => u.isActive).length,
    signedInThisWeek: users.filter((u) => u.isActive && u.lastLoginAt && u.lastLoginAt.getTime() >= weekAgo).length,
    employees: employees.length,
    employeesWithLogin: employees.filter((e) => e.userId).length,
    byRole: [...roles.values()].sort((a, b) => b.value - a.value),
    byDepartment: [...byDept].map(([id, value]) => ({ id, label: names.get(id) ?? "No department", value })).sort((a, b) => b.value - a.value),
  };
}

export interface AdminActivityRow {
  id: string;
  scope: string;
  message: string;
  actor: string | null;
  createdAt: Date;
  warn: boolean;
}

const READABLE: Record<string, string> = {
  EMPLOYEE_CREATED: "Employee added",
  EMPLOYEE_UPDATED: "Employee details changed",
  EMPLOYEE_ACTIVATED: "Employee reactivated",
  EMPLOYEE_DEACTIVATED: "Employee deactivated",
  DEPARTMENT_CREATED: "Department added",
  DEPARTMENT_UPDATED: "Department changed",
  DEPARTMENT_DELETED: "Department deleted",
  JOB_TITLE_CREATED: "Job title added",
  JOB_TITLE_UPDATED: "Job title changed",
  JOB_TITLE_DELETED: "Job title deleted",
  USER_CREATED: "Login created",
  USER_MFA_RESET: "Two-step sign-in reset",
};

/** What the administrators did lately, from the portal's own System Log entries. Main Admins only (the caller checks). */
export async function getAdminActivity(limit = 7): Promise<AdminActivityRow[]> {
  const rows = await platformPrisma.systemLog.findMany({
    where: { projectId: null, scope: { in: ["projects", "users", "configuration", "permissions", "branding"] } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, scope: true, message: true, level: true, createdAt: true, actorUser: { select: { username: true } }, metadata: true },
  });
  return rows.map((r) => {
    const meta = r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata) ? (r.metadata as Record<string, unknown>) : {};
    const named = [meta.changedBy, meta.createdBy, meta.by].find((v): v is string => typeof v === "string" && v.length > 0) ?? null;
    const code = /^[A-Z][A-Z0-9_]+$/.test(r.message);
    // "Project "X" status SUSPENDED → ACTIVE" reads as the project and its new state.
    const moved = /^Project "(.+)" status ([A-Z]+) → ([A-Z]+)$/.exec(r.message);
    const movedTo = moved && isProjectStatus(moved[3]!) ? `${moved[1]} is now ${PROJECT_STATUS_LABELS[moved[3] as keyof typeof PROJECT_STATUS_LABELS].toLowerCase()}` : null;
    return {
      id: r.id,
      scope: r.scope,
      message: movedTo ?? READABLE[r.message] ?? (code ? r.message.charAt(0) + r.message.slice(1).toLowerCase().replace(/_/g, " ") : r.message),
      actor: r.actorUser?.username ?? named,
      createdAt: r.createdAt,
      warn: r.level === "WARN" || r.level === "ERROR",
    };
  });
}
