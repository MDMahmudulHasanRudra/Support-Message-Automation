import {
  isProjectAssignableKey,
  projectMemberActions,
  type ProjectAccessLevelValue,
  type ProjectMemberActions,
} from "@support-automation/shared";
import { platformPrisma, prisma } from "@/server/db";
import { isMainAdmin } from "@/server/projectContext";
import { PRIVILEGED_KEYS } from "@/server/privilegeGuard";

/**
 * Project administration reads (PROJECT_ROLES.md): the members of ONE project and its project roles.
 * Not a "use server" file — nothing here is an endpoint; the actions in
 * `server/actions/projectAdmin.ts` check who is asking.
 *
 * Users, project access and the per-project role assignment are platform tables, always read here
 * with an explicit `projectId`; project roles are project-owned and go through the scoped client,
 * which confines them to the project in the URL.
 */

export interface ProjectMemberView {
  userId: string;
  username: string;
  name: string;
  email: string | null;
  isActive: boolean;
  lastLoginAt: Date | null;
  isLead: boolean;
  isMainAdmin: boolean;
  /** READ / WRITE / FULL — how much of their role they may use here. */
  level: ProjectAccessLevelValue;
  projectRole: { id: string; name: string } | null;
  /** Their platform role, shown so a Lead can see where a member's other rights come from. */
  globalRoleName: string | null;
  /** How many OTHER projects they may enter. */
  otherProjects: number;
  isSelf: boolean;
  can: ProjectMemberActions;
}

/** Facts about one person, from the point of view of one project. Null when they are not a member. */
export async function memberFacts(projectId: string, userId: string, actorUserId: string) {
  const user = await platformPrisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      isActive: true,
      permissionModuleId: true,
      permissionModule: { select: { name: true, permissions: { where: { permission: { key: { in: [...PRIVILEGED_KEYS] } } }, select: { permissionId: true } } } },
      projectAccess: { select: { projectId: true, level: true } },
      projectMemberRoles: { where: { projectId }, select: { isLead: true, projectRoleId: true } },
    },
  });
  if (!user) return null;
  const here = user.projectAccess.find((a) => a.projectId === projectId);
  if (!here) return null;
  const memberRole = user.projectMemberRoles[0] ?? null;
  const actorIsMainAdmin = await isMainAdmin(actorUserId);
  const otherProjects = user.projectAccess.filter((a) => a.projectId !== projectId).length;
  const targetIsPrivileged = (user.permissionModule?.permissions.length ?? 0) > 0;
  const can = projectMemberActions({
    actorIsMainAdmin,
    isSelf: userId === actorUserId,
    targetIsPrivileged,
    targetIsLead: memberRole?.isLead ?? false,
    targetIsProjectOnly: otherProjects === 0 && user.permissionModuleId === null,
  });
  return { user, level: (here.level ?? "FULL") as ProjectAccessLevelValue, memberRole, otherProjects, targetIsPrivileged, actorIsMainAdmin, can };
}

export async function listProjectMembers(projectId: string, actorUserId: string): Promise<ProjectMemberView[]> {
  const [rows, memberRoles, actorIsMainAdmin] = await Promise.all([
    platformPrisma.projectAccess.findMany({
      where: { projectId },
      select: {
        level: true,
        user: {
          select: {
            id: true,
            username: true,
            name: true,
            email: true,
            isActive: true,
            lastLoginAt: true,
            permissionModuleId: true,
            permissionModule: {
              select: { name: true, permissions: { where: { permission: { key: { in: [...PRIVILEGED_KEYS] } } }, select: { permission: { select: { key: true } } } } },
            },
            projectAccess: { select: { projectId: true } },
          },
        },
      },
    }),
    platformPrisma.projectMemberRole.findMany({
      where: { projectId },
      select: { userId: true, isLead: true, projectRole: { select: { id: true, name: true } } },
    }),
    isMainAdmin(actorUserId),
  ]);
  const byUser = new Map(memberRoles.map((m) => [m.userId, m] as const));
  return rows
    .map(({ level, user }) => {
      const memberRole = byUser.get(user.id);
      const privilegedKeys = user.permissionModule?.permissions.map((p) => p.permission.key) ?? [];
      const otherProjects = user.projectAccess.filter((a) => a.projectId !== projectId).length;
      const isLead = memberRole?.isLead ?? false;
      return {
        userId: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
        isActive: user.isActive,
        lastLoginAt: user.lastLoginAt,
        isLead,
        isMainAdmin: privilegedKeys.includes("projects.manage"),
        level: (level ?? "FULL") as ProjectAccessLevelValue,
        projectRole: memberRole?.projectRole ?? null,
        globalRoleName: user.permissionModule?.name ?? null,
        otherProjects,
        isSelf: user.id === actorUserId,
        can: projectMemberActions({
          actorIsMainAdmin,
          isSelf: user.id === actorUserId,
          targetIsPrivileged: privilegedKeys.length > 0,
          targetIsLead: isLead,
          targetIsProjectOnly: otherProjects === 0 && user.permissionModuleId === null,
        }),
      };
    })
    .sort((a, b) => Number(b.isLead) - Number(a.isLead) || a.name.localeCompare(b.name));
}

export interface ProjectRoleView {
  id: string;
  name: string;
  description: string | null;
  permissionKeys: string[];
  memberCount: number;
}

/** This project's roles (the scoped client confines them to the project in the URL). */
export async function listProjectRoles(): Promise<ProjectRoleView[]> {
  const roles = await prisma.projectRole.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, description: true, permissionKeys: true, _count: { select: { members: true } } },
  });
  return roles.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    // Read through the same filter as every write: a retired or platform key means nothing here.
    permissionKeys: r.permissionKeys.filter(isProjectAssignableKey),
    memberCount: r._count.members,
  }));
}

export async function getProjectRole(id: string): Promise<ProjectRoleView | null> {
  const role = await prisma.projectRole.findFirst({
    where: { id },
    select: { id: true, name: true, description: true, permissionKeys: true, _count: { select: { members: true } } },
  });
  if (!role) return null;
  return { id: role.id, name: role.name, description: role.description, permissionKeys: role.permissionKeys.filter(isProjectAssignableKey), memberCount: role._count.members };
}
