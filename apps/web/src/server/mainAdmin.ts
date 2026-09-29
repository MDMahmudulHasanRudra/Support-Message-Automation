import { notFound } from "next/navigation";
import { getDhakaDayRange, resolveProjectFeatures, type ProjectStatusValue } from "@support-automation/shared";
import { platformPrisma } from "@/server/db";
import { requireSession, type Session } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { isMainAdmin } from "@/server/projectContext";

/**
 * The Main Admin Portal's data and its gate (MULTI_PROJECT_PLAN.md §7–§8).
 *
 * The portal is about projects, not inside one, so it reads through the PLATFORM client and names
 * each project explicitly. It only ever COUNTS a project's rows; it shows no message, group or
 * customer from any of them — detailed figures stay inside the project, behind its own access and
 * permission checks.
 *
 * The gate is the existing permission system with two new keys: `projects.view` to look,
 * `projects.manage` to change anything. Without `projects.view` the portal does not exist for the
 * user (404), the same way a project they cannot enter does not.
 */
export async function requireMainAdminPage(): Promise<{ session: Session; canManage: boolean }> {
  const session = await requireSession();
  if (!(await hasPermission(session, "projects.view"))) notFound();
  return { session, canManage: await hasPermission(session, "projects.manage") };
}

/** For a page that only a Main Admin may open (create a project). */
export async function requireMainAdminManagePage(): Promise<Session> {
  const { session, canManage } = await requireMainAdminPage();
  if (!canManage) notFound();
  return session;
}

const OPEN_ESCALATION_STATUSES = [
  "NEW",
  "MONITORING",
  "WAITING_FOR_HUMAN",
  "SECOND_ALERT",
  "MEMBER_ESCALATED",
  "ADMIN_ESCALATED",
  "FOLLOW_UP",
] as const;

const NEEDS_PERSON = new Set(["AUTHENTICATION_REQUIRED", "SESSION_ERROR"]);
const DOWN = new Set(["DISCONNECTED", "ERROR", "RECONNECTING"]);

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: ProjectStatusValue;
  createdAt: Date;
  whatsapp: { total: number; connected: number; needsPerson: number; down: number };
  monitoredGroups: number;
  teamMembers: number;
  messagesToday: number;
  openEscalations: number;
  usersWithAccess: number;
  /** Plain-language reasons this project needs a Main Admin's attention, if any. */
  attention: string[];
  /** Whether the viewer may open it — access, or Main Admin. The portal lists projects either way. */
  canEnter: boolean;
}

function countBy<T extends { projectId: string; _count: { _all: number } }>(rows: T[]): Map<string, number> {
  return new Map(rows.map((row) => [row.projectId, row._count._all]));
}

/** Every project with its high-level figures, oldest first. Archived ones only when asked for. */
export async function getProjectSummaries(viewerId: string, options: { includeArchived?: boolean } = {}): Promise<ProjectSummary[]> {
  const projects = await platformPrisma.project.findMany({
    where: options.includeArchived ? {} : { status: { not: "ARCHIVED" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, slug: true, description: true, status: true, createdAt: true },
  });
  if (projects.length === 0) return [];
  const ids = projects.map((p) => p.id);
  const inProjects = { projectId: { in: ids } };
  const today = getDhakaDayRange(new Date());

  const [accounts, groups, members, messages, escalations, access, viewerAccess, viewerIsMainAdmin] = await Promise.all([
    platformPrisma.whatsAppAccount.findMany({ where: inProjects, select: { projectId: true, status: true } }),
    platformPrisma.whatsAppGroup.groupBy({ by: ["projectId"], where: { ...inProjects, isMonitored: true, isActive: true }, _count: { _all: true } }),
    platformPrisma.internalTeamMember.groupBy({ by: ["projectId"], where: { ...inProjects, status: "ACTIVE" }, _count: { _all: true } }),
    platformPrisma.message.groupBy({
      by: ["projectId"],
      where: { ...inProjects, timestampWa: { gte: today.start, lt: today.end } },
      _count: { _all: true },
    }),
    platformPrisma.supportEscalationCase.groupBy({
      by: ["projectId"],
      where: { ...inProjects, status: { in: [...OPEN_ESCALATION_STATUSES] } },
      _count: { _all: true },
    }),
    platformPrisma.projectAccess.groupBy({ by: ["projectId"], where: inProjects, _count: { _all: true } }),
    platformPrisma.projectAccess.findMany({ where: { ...inProjects, userId: viewerId }, select: { projectId: true } }),
    isMainAdmin(viewerId),
  ]);

  const groupCounts = countBy(groups);
  const memberCounts = countBy(members);
  const messageCounts = countBy(messages);
  const escalationCounts = countBy(escalations);
  const accessCounts = countBy(access);
  const enterable = new Set(viewerAccess.map((row) => row.projectId));

  return projects.map((project) => {
    const own = accounts.filter((a) => a.projectId === project.id);
    const whatsapp = {
      total: own.length,
      connected: own.filter((a) => a.status === "CONNECTED").length,
      needsPerson: own.filter((a) => NEEDS_PERSON.has(a.status)).length,
      down: own.filter((a) => DOWN.has(a.status)).length,
    };
    const attention: string[] = [];
    if (project.status === "ACTIVE" && whatsapp.total === 0) attention.push("No WhatsApp account linked yet.");
    if (whatsapp.needsPerson > 0) attention.push(`${whatsapp.needsPerson} WhatsApp account(s) need someone with the phone to link again.`);
    if (whatsapp.down > 0) attention.push(`${whatsapp.down} WhatsApp account(s) not connected.`);
    if (project.status === "SUSPENDED") attention.push("Suspended — read-only, nothing is being sent.");
    return {
      ...project,
      status: project.status as ProjectStatusValue,
      whatsapp,
      monitoredGroups: groupCounts.get(project.id) ?? 0,
      teamMembers: memberCounts.get(project.id) ?? 0,
      messagesToday: messageCounts.get(project.id) ?? 0,
      openEscalations: escalationCounts.get(project.id) ?? 0,
      usersWithAccess: accessCounts.get(project.id) ?? 0,
      attention,
      canEnter: viewerIsMainAdmin || enterable.has(project.id),
    };
  });
}

export interface ProjectDetail {
  project: ProjectSummary;
  features: ReturnType<typeof resolveProjectFeatures>;
  /** Every active user, whether they may enter this project, and their existing role — shown, never changed here. */
  users: Array<{ id: string; username: string; name: string; role: string | null; hasAccess: boolean; isMainAdmin: boolean }>;
  /** Which of the project's own settings rows exist — a new project has all ten. */
  configuration: Array<{ label: string; present: boolean }>;
}

export async function getProjectDetail(viewerId: string, projectId: string): Promise<ProjectDetail | null> {
  const summaries = await getProjectSummaries(viewerId, { includeArchived: true });
  const project = summaries.find((p) => p.id === projectId);
  if (!project) return null;

  const where = { projectId };
  const [featureRows, users, accessRows, ...settings] = await Promise.all([
    platformPrisma.projectFeature.findMany({ where, select: { key: true, enabled: true } }),
    platformPrisma.user.findMany({
      where: { isActive: true },
      orderBy: { username: "asc" },
      select: {
        id: true,
        username: true,
        name: true,
        permissionModule: {
          select: { name: true, permissions: { where: { permission: { key: "projects.manage" } }, select: { permissionId: true } } },
        },
      },
    }),
    platformPrisma.projectAccess.findMany({ where, select: { userId: true } }),
    platformPrisma.automationSettings.count({ where }),
    platformPrisma.aiSettings.count({ where }),
    platformPrisma.groupBroadcastSettings.count({ where }),
    platformPrisma.groupParticipantAddSettings.count({ where }),
    platformPrisma.supportEscalationSettings.count({ where }),
    platformPrisma.learningSettings.count({ where }),
    platformPrisma.supportActivitySettings.count({ where }),
    platformPrisma.forgeSettings.count({ where }),
    platformPrisma.teamManagementSettings.count({ where }),
    platformPrisma.communicationStyleProfile.count({ where }),
  ]);
  const withAccess = new Set(accessRows.map((row) => row.userId));
  const labels = [
    "Automation & safety",
    "AI settings",
    "Broadcast limits",
    "Add-to-groups limits",
    "Escalation settings",
    "Conversation Learning",
    "Support Activity",
    "Product knowledge (Forge)",
    "Team Management",
    "Communication style",
  ];

  return {
    project,
    features: resolveProjectFeatures(featureRows),
    users: users.map((user) => ({
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.permissionModule?.name ?? null,
      hasAccess: withAccess.has(user.id),
      isMainAdmin: (user.permissionModule?.permissions.length ?? 0) > 0,
    })),
    configuration: labels.map((label, index) => ({ label, present: (settings[index] as number) > 0 })),
  };
}
