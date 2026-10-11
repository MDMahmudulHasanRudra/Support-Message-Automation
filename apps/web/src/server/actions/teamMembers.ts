"use server";

import { projectPath } from "@/server/projectPaths";
import { prisma } from "@/server/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type Prisma } from "@support-automation/db";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { checkPermission, requireAccess } from "@/server/authorize";
import { createSenderResolver, normalizePhoneNumber, parseWhatsAppId, whatsappIdKey } from "@support-automation/shared";
import { loginsForProject } from "@/server/projectLogins";
import { logSystemEvent } from "@/server/logSystemEvent";

export interface TeamMemberFormState {
  error?: string;
  success?: boolean;
}

interface TeamMemberInput {
  name: string;
  phoneNumber: string;
  /**
   * The WhatsApp id the sender carries in groups (a long LID such as 145938777669643), kept beside
   * the real number. Null = none stored. Matching tries this exactly before the phone number.
   */
  whatsappId: string | null;
  /** The designation (Support Executive, CTO...) — stored in the `role` column. */
  role: string;
  department: string | null;
  teamId: string | null;
  status: "ACTIVE" | "INACTIVE";
}

/**
 * Reads and checks the form, returning a message for anything wrong instead of throwing.
 *
 * These actions used to `throw new Error("Name, phone number, and role are required.")`. A throw in
 * a Server Action does not reach the form — it replaces the whole page with the error boundary — so
 * the one message written for the person filling the form in was the one they could never see. The
 * inputs are `required`, but a name of three spaces passes that and trimmed to nothing here.
 */
function readTeamMemberForm(formData: FormData): TeamMemberInput | { error: string } {
  const name = String(formData.get("name") ?? "").trim();
  const phoneNumber = String(formData.get("phoneNumber") ?? "").trim();
  const role = String(formData.get("role") ?? "").trim();
  // The id as the worker stores a sender: no "@lid" / "@c.us" suffix, which is stripped before
  // comparing, so pasting either form works.
  const whatsappId = String(formData.get("whatsappId") ?? "").trim().replace(/@.*$/, "").replace(/\s+/g, "") || null;
  const department = String(formData.get("department") ?? "").trim() || null;
  const teamId = String(formData.get("teamId") ?? "").trim() || null;
  const status = formData.get("status") === "INACTIVE" ? "INACTIVE" : "ACTIVE";
  if (!name || !phoneNumber || !role) return { error: "Name, phone number and designation are all required." };
  if (!normalizePhoneNumber(phoneNumber)) {
    return { error: "That does not look like a phone number. Enter it with the country code, e.g. +8801XXXXXXXXX." };
  }
  if (whatsappId && !/^\d{6,}$/.test(whatsappId)) {
    return { error: "The WhatsApp ID is digits only (for example 145938777669643). Leave it empty if you do not have one." };
  }
  return { name, phoneNumber, whatsappId, role, department, teamId, status };
}

/**
 * The chosen Team must exist, and must be active unless the member is already in it — a disabled
 * Team is not offered for new assignments, but editing somebody who is still in one must not force
 * them out of it.
 */
async function checkTeam(teamId: string | null, currentTeamId: string | null = null): Promise<string | null> {
  if (!teamId) return null;
  const team = await prisma.team.findUnique({ where: { id: teamId }, select: { status: true, name: true } });
  if (!team) return "That team no longer exists. Pick another, or refresh the page.";
  if (team.status === "DISABLED" && teamId !== currentTeamId) {
    return `${team.name} is disabled. Enable it on the Teams page, or pick another team.`;
  }
  return null;
}

/**
 * Moves a member to a Team (or to none), keeping the history reports read.
 *
 * Closes their open membership and opens a new one, in the caller's transaction so `teamId` and the
 * memberships can never disagree. Somebody's FIRST Team gets no start date — it counts back over
 * everything they did before Teams existed, so reports are filterable the day Teams are set up. Every
 * later change is dated now, so last month's report keeps them where they were last month.
 */
async function applyTeamChange(
  tx: Prisma.TransactionClient,
  memberId: string,
  nextTeamId: string | null,
  now: Date,
): Promise<void> {
  const hasHistory = (await tx.teamMembership.count({ where: { teamMemberId: memberId } })) > 0;
  await tx.teamMembership.updateMany({ where: { teamMemberId: memberId, endedAt: null }, data: { endedAt: now } });
  if (nextTeamId) {
    await tx.teamMembership.create({
      data: { teamMemberId: memberId, teamId: nextTeamId, startedAt: hasHistory ? now : null },
    });
  }
}

/**
 * Whoever already holds this number, compared DIGITS-ONLY — or null.
 *
 * `phoneNumber @unique` only rejects a byte-identical duplicate, so `+8801711…` and `8801711…` were
 * both accepted as two different people. That is not a cosmetic duplicate: team-member matching
 * normalises to digits, so the same colleague's messages split across two identities and every
 * per-member count — attendance, Team Performance, first response — goes quietly wrong. The
 * add-from-group paths below have always compared this way; the manual form never did.
 *
 * `whatsappId` is compared too, because a member added from message history has their WhatsApp id
 * stored where a number would be, and typing that same id in again is the same person.
 */
async function findPhoneConflict(phoneNumber: string, excludeId?: string) {
  const digits = normalizePhoneNumber(phoneNumber);
  if (!digits) return null;
  const members = await prisma.internalTeamMember.findMany({
    select: { id: true, name: true, phoneNumber: true, whatsappId: true },
  });
  return (
    members.find(
      (m) =>
        m.id !== excludeId &&
        (normalizePhoneNumber(m.phoneNumber) === digits || (m.whatsappId && normalizePhoneNumber(m.whatsappId) === digits)),
    ) ?? null
  );
}

/**
 * Whoever already holds this WhatsApp id — as their own id, or as a number with the same digits —
 * or null. Two members sharing one id would make every message from it match whichever came first.
 */
async function findWhatsAppIdConflict(whatsappId: string | null, excludeId?: string) {
  if (!whatsappId) return null;
  const members = await prisma.internalTeamMember.findMany({
    select: { id: true, name: true, phoneNumber: true, whatsappId: true },
  });
  return (
    members.find(
      (m) =>
        m.id !== excludeId &&
        (m.whatsappId === whatsappId || normalizePhoneNumber(m.phoneNumber) === normalizePhoneNumber(whatsappId)),
    ) ?? null
  );
}

export async function createTeamMember(_prev: TeamMemberFormState, formData: FormData): Promise<TeamMemberFormState> {
  const granted = await checkPermission("whatsapp.manage");
  if ("denied" in granted) return { error: granted.denied };
  const input = readTeamMemberForm(formData);
  if ("error" in input) return input;

  const conflict = await findPhoneConflict(input.phoneNumber);
  if (conflict) return { error: `${conflict.name} already has that number.` };
  const idConflict = await findWhatsAppIdConflict(input.whatsappId);
  if (idConflict) return { error: `${idConflict.name} already has that WhatsApp ID.` };
  const teamProblem = await checkTeam(input.teamId);
  if (teamProblem) return { error: teamProblem };

  let createdId: string;
  try {
    createdId = await prisma.$transaction(async (tx) => {
      const created = await tx.internalTeamMember.create({ data: input, select: { id: true } });
      if (input.teamId) await applyTeamChange(tx, created.id, input.teamId, new Date());
      return created.id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "Someone already has that number." };
    throw err;
  }
  await logIdentityChange(granted.session.userId, createdId, input.name, null, { phoneNumber: input.phoneNumber, whatsappId: input.whatsappId }, "form");
  revalidatePath(await projectPath("/team-members"));
  return { success: true };
}

/**
 * Identity mapping history (WHATSAPP_IDENTITY.md §4): every change to the identifiers a member's
 * messages are matched on is a System Log entry, old and new side by side. Attribution in every
 * report follows these two columns, so "why did last month's figures move?" has to be answerable.
 */
async function logIdentityChange(
  actorUserId: string,
  memberId: string,
  memberName: string,
  before: { phoneNumber: string; whatsappId: string | null } | null,
  after: { phoneNumber: string; whatsappId: string | null },
  via: "form" | "chat-link",
): Promise<void> {
  if (before && before.phoneNumber === after.phoneNumber && before.whatsappId === after.whatsappId) return;
  await logSystemEvent(
    "INFO",
    "team-members",
    before
      ? `Identifiers of team member ${memberName} changed${via === "chat-link" ? " (WhatsApp sender linked from WhatsApp Chat)" : ""}`
      : `Team member ${memberName} added`,
    { before, after, via },
    { actorUserId, targetType: "InternalTeamMember", targetId: memberId },
  );
}

export interface GroupParticipantCandidate {
  phoneNumber: string;
  /** The push name WhatsApp supplied, if this person has ever set one. */
  suggestedName: string | null;
  messageCount: number;
  lastSeenAt: Date;
}

/**
 * The people who have actually spoken in a group and are not yet on the team roster.
 *
 * Typing a colleague's number by hand is the step where this feature goes wrong: the number is
 * the exact match key, and one wrong digit means their messages are processed as a customer's —
 * which can auto-reply to your own staff or open escalation cases against their chatter. Picking
 * from people the system has genuinely seen sending messages removes that failure entirely,
 * because the number comes from WhatsApp rather than from a keyboard.
 */
export async function getGroupParticipantCandidates(groupId: string): Promise<GroupParticipantCandidate[]> {
  const granted = await checkPermission("whatsapp.view");
  if ("denied" in granted) return [];

  const [senders, existing] = await Promise.all([
    prisma.message.groupBy({
      by: ["senderPhone"],
      where: { groupId },
      _count: { senderPhone: true },
      _max: { timestampWa: true },
      orderBy: { _count: { senderPhone: "desc" } },
      take: 100,
    }),
    prisma.internalTeamMember.findMany({ select: { id: true, phoneNumber: true, whatsappId: true } }),
  ]);
  const group = await prisma.whatsAppGroup.findUnique({ where: { id: groupId }, select: { whatsappGroupId: true } });

  // The one identity rule (WHATSAPP_IDENTITY.md): an exact WhatsApp id, or the same phone digits
  // however either side was written, so an existing colleague is never offered again and added
  // twice. A sender equal to the GROUP's own id is a message WhatsApp named no author for, never a
  // person to add.
  const resolver = createSenderResolver(existing);
  const groupUser = parseWhatsAppId(group?.whatsappGroupId)?.user ?? null;
  const isOnRoster = (senderId: string) => senderId === groupUser || resolver.resolve(senderId).isRosterMember;
  const candidatePhones = senders.map((s) => s.senderPhone).filter((phone) => !isOnRoster(phone));
  if (candidatePhones.length === 0) return [];

  // One name per number: the most recent non-null push name they sent under. A person who has
  // since cleared their WhatsApp name still gets their last known one rather than nothing.
  const named = await prisma.message.findMany({
    where: { groupId, senderPhone: { in: candidatePhones }, senderName: { not: null } },
    distinct: ["senderPhone"],
    orderBy: { timestampWa: "desc" },
    select: { senderPhone: true, senderName: true },
    // Bounded because Prisma applies `distinct` after fetching: without a ceiling a busy group
    // would pull its whole history into memory to find at most a hundred names. Someone whose
    // last message falls outside this window simply shows as "(no WhatsApp name)" and can still
    // be selected by number — a softer failure than a slow page.
    take: 1000,
  });
  const nameByPhone = new Map(named.map((m) => [m.senderPhone, m.senderName]));

  return senders
    .filter((s) => !isOnRoster(s.senderPhone))
    .map((s) => ({
      phoneNumber: s.senderPhone,
      suggestedName: nameByPhone.get(s.senderPhone) ?? null,
      messageCount: s._count.senderPhone,
      lastSeenAt: s._max.timestampWa ?? new Date(0),
    }));
}

export interface RosterFetchState {
  status: "IDLE" | "PENDING" | "READY" | "FAILED";
  participants: GroupParticipantCandidate[];
  error?: string;
}

/**
 * Asks the worker who is actually in a group, rather than inferring it from message history.
 *
 * History only knows the people who have spoken since this app started watching, which is nobody
 * at all for a group that is quiet or one being set up before any traffic exists — exactly when
 * you most want to populate the roster. This goes to WhatsApp's own membership list instead.
 *
 * Deduplicated against a run already in flight for the same group, so repeated clicks are free.
 */
export async function requestGroupParticipants(groupId: string): Promise<void> {
  await requireAccess("whatsapp.manage");

  // Filtered on the payload's group in the database (PostgreSQL JSON path). Only the NEWEST command
  // project-wide used to be checked, so another group's request in flight let this one queue a
  // duplicate.
  const inFlight = await prisma.workerCommand.findFirst({
    where: { type: "GET_GROUP_PARTICIPANTS", status: { in: ["PENDING", "PROCESSING"] }, payload: { path: ["groupId"], equals: groupId } },
    select: { id: true },
  });
  if (inFlight) return;

  const group = await prisma.whatsAppGroup.findUnique({ where: { id: groupId }, select: { accountId: true } });
  if (!group) return;

  await prisma.workerCommand.create({
    data: { type: "GET_GROUP_PARTICIPANTS", accountId: group.accountId, payload: { groupId } },
  });
}

/**
 * Reads the most recent roster the worker produced for this group.
 *
 * People already on the team roster are filtered out here rather than hidden in the UI, so the
 * count the operator sees is the count they can actually act on.
 */
export async function readGroupParticipants(groupId: string): Promise<RosterFetchState> {
  const granted = await checkPermission("whatsapp.view");
  if ("denied" in granted) return { status: "FAILED", participants: [], error: granted.denied };

  // THIS group's newest request. Reading the newest request project-wide meant two people fetching
  // two groups at once each saw "nothing yet" for whichever was not last.
  const command = await prisma.workerCommand.findFirst({
    where: { type: "GET_GROUP_PARTICIPANTS", payload: { path: ["groupId"], equals: groupId } },
    orderBy: { createdAt: "desc" },
  });
  if (!command) return { status: "IDLE", participants: [] };

  if (command.status === "PENDING" || command.status === "PROCESSING") {
    return { status: "PENDING", participants: [] };
  }
  if (command.status === "FAILED") {
    return {
      status: "FAILED",
      participants: [],
      error:
        (command.result as { error?: string } | null)?.error ??
        "The worker could not read this group's members. Check that the account is still connected.",
    };
  }

  const raw = (
    command.result as { participants?: Array<{ phoneNumber?: string; rawId?: string; name?: string | null; isSelf?: boolean }> } | null
  )?.participants;
  if (!Array.isArray(raw)) return { status: "IDLE", participants: [] };

  // The one identity rule, with the domain WhatsApp gave, so a LID is never mistaken for a number.
  const resolver = createSenderResolver(await prisma.internalTeamMember.findMany({ select: { id: true, phoneNumber: true, whatsappId: true } }));
  const rawIdOf = new Map(raw.map((r) => [String(r?.phoneNumber ?? ""), r?.rawId ?? null]));

  const participants = raw
    // The signed-in account is the business's own WhatsApp line, never a colleague to add.
    .filter((p) => p?.phoneNumber && !p.isSelf)
    .map((p) => ({
      phoneNumber: String(p.phoneNumber),
      suggestedName: p.name ?? null,
      messageCount: 0,
      lastSeenAt: new Date(0),
    }))
    .filter((p) => normalizePhoneNumber(p.phoneNumber) !== null && resolver.resolve(p.phoneNumber, rawIdOf.get(p.phoneNumber)).status === "UNRESOLVED");

  return { status: "READY", participants };
}

export interface AddFromGroupState {
  error?: string;
  addedCount?: number;
}

/**
 * Adds one or more people picked out of a group to the team roster in a single step.
 *
 * Numbers already on the roster are skipped rather than failing the whole batch — selecting
 * someone who was added a moment ago in another tab should not throw away the rest of the
 * selection.
 */
export async function addTeamMembersFromGroup(
  _prevState: AddFromGroupState,
  formData: FormData,
): Promise<AddFromGroupState> {
  const granted = await checkPermission("whatsapp.manage");
  if ("denied" in granted) return { error: granted.denied };

  const role = String(formData.get("role") ?? "").trim() || "Support";
  const department = String(formData.get("department") ?? "").trim() || null;
  const teamId = String(formData.get("teamId") ?? "").trim() || null;
  const teamProblem = await checkTeam(teamId);
  if (teamProblem) return { error: teamProblem };
  const selections = formData.getAll("selected").map((value) => String(value));

  if (selections.length === 0) return { error: "Pick at least one person to add." };

  const parsed = selections
    .map((value) => {
      // "<phone>|<name>" — the name travels with the checkbox so the server does not have to
      // re-derive it, and an empty name falls back to the number itself.
      const separator = value.indexOf("|");
      const phoneNumber = (separator === -1 ? value : value.slice(0, separator)).trim();
      const name = (separator === -1 ? "" : value.slice(separator + 1)).trim();
      return { phoneNumber, name: name || phoneNumber };
    })
    .filter((entry) => entry.phoneNumber.length > 0);

  if (parsed.length === 0) return { error: "Pick at least one person to add." };

  // `skipDuplicates` only catches a byte-identical number, but "+8801700000123" and
  // "8801700000123" are the same colleague. Two rows for one person splits their support activity
  // across two identities and makes per-member counts quietly wrong, so the duplicate check is
  // done on digits before the insert rather than left to the unique index.
  const existing = await prisma.internalTeamMember.findMany({ select: { phoneNumber: true, whatsappId: true } });
  const seen = new Set(
    existing.map((m) => normalizePhoneNumber(m.phoneNumber)).filter((d): d is string => d !== null),
  );
  const seenWhatsAppIds = new Set(existing.map((m) => m.whatsappId).filter((id): id is string => Boolean(id)));

  const toCreate: Array<{ name: string; phoneNumber: string; whatsappId: string }> = [];
  for (const entry of parsed) {
    if (seenWhatsAppIds.has(entry.phoneNumber)) continue;
    const digits = normalizePhoneNumber(entry.phoneNumber);
    if (digits === null || seen.has(digits)) continue;
    seen.add(digits);
    seenWhatsAppIds.add(entry.phoneNumber);
    // Whatever this identifier is — a phone number or a LID — it is exactly what arrives on this
    // person's messages, so it is recorded as such. That is what makes the match survive an admin
    // later correcting `phoneNumber` to the person's real, human-readable number.
    toCreate.push({ name: entry.name, phoneNumber: entry.phoneNumber, whatsappId: entry.phoneNumber });
  }

  if (toCreate.length === 0) {
    return { error: "Everyone selected is already on the roster." };
  }

  const result = await prisma.$transaction(async (tx) => {
    const created = await tx.internalTeamMember.createMany({
      data: toCreate.map((entry) => ({
        name: entry.name,
        phoneNumber: entry.phoneNumber,
        whatsappId: entry.whatsappId,
        role,
        department,
        teamId,
        status: "ACTIVE" as const,
      })),
      skipDuplicates: true,
    });
    if (teamId) {
      // createMany returns no ids, so the new rows are found by the numbers just inserted. Their
      // first Team, so it carries no start date (see applyTeamChange).
      const fresh = await tx.internalTeamMember.findMany({
        where: { phoneNumber: { in: toCreate.map((entry) => entry.phoneNumber) }, teamId, teamMemberships: { none: {} } },
        select: { id: true },
      });
      await tx.teamMembership.createMany({
        data: fresh.map((member) => ({ teamMemberId: member.id, teamId, startedAt: null })),
      });
    }
    return created;
  });

  revalidatePath(await projectPath("/team-members"));
  return { addedCount: result.count };
}

export async function updateTeamMember(
  id: string,
  _prev: TeamMemberFormState,
  formData: FormData,
): Promise<TeamMemberFormState> {
  const granted = await checkPermission("whatsapp.manage");
  if ("denied" in granted) return { error: granted.denied };
  const input = readTeamMemberForm(formData);
  if ("error" in input) return input;

  // Excluding this member, so saving without changing the number is not reported as a clash with
  // themselves — and so typing a real number over a WhatsApp id works, which is the whole point of
  // this form for anybody added from message history.
  const conflict = await findPhoneConflict(input.phoneNumber, id);
  if (conflict) return { error: `${conflict.name} already has that number.` };
  const idConflict = await findWhatsAppIdConflict(input.whatsappId, id);
  if (idConflict) return { error: `${idConflict.name} already has that WhatsApp ID.` };
  const current = await prisma.internalTeamMember.findUnique({ where: { id }, select: { teamId: true, phoneNumber: true, whatsappId: true } });
  if (!current) return { error: "This team member no longer exists." };
  const teamProblem = await checkTeam(input.teamId, current.teamId);
  if (teamProblem) return { error: teamProblem };

  try {
    await prisma.$transaction(async (tx) => {
      await tx.internalTeamMember.update({ where: { id }, data: input });
      if (current.teamId !== input.teamId) await applyTeamChange(tx, id, input.teamId, new Date());
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "Someone already has that number." };
    throw err;
  }
  await logIdentityChange(
    granted.session.userId,
    id,
    input.name,
    { phoneNumber: current.phoneNumber, whatsappId: current.whatsappId },
    { phoneNumber: input.phoneNumber, whatsappId: input.whatsappId },
    "form",
  );
  revalidatePath(await projectPath("/team-members"));
  redirect(await projectPath("/team-members"));
}

export interface LinkSenderState {
  error?: string;
  linked?: string;
}

/**
 * Records that a WhatsApp sender IS a given team member: the human verification the identity rule
 * cannot do by itself (WHATSAPP_IDENTITY.md §4). WhatsApp puts a private id (a LID) on most group
 * messages, and nothing WhatsApp exposes here links it to the phone number a person was entered
 * with, so a colleague typed in by phone number is processed as a customer until somebody says who
 * they are. Offered from the contact panel in WhatsApp Chat, where the evidence (their messages,
 * their WhatsApp name) is on screen.
 *
 * Fills `whatsappId` only, and only when the member has none: replacing one already recorded is an
 * edit of who somebody is, and belongs on their edit page, with the old value in front of you. The
 * same conflict checks as the form apply, and the change is a System Log entry.
 */
export async function linkWhatsAppSender(senderId: string, _prev: LinkSenderState, formData: FormData): Promise<LinkSenderState> {
  const granted = await checkPermission("whatsapp.manage");
  if ("denied" in granted) return { error: granted.denied };
  const memberId = String(formData.get("memberId") ?? "").trim();
  if (!memberId) return { error: "Pick the team member this person is." };

  const parsed = parseWhatsAppId(senderId);
  if (!parsed || parsed.kind === "GROUP" || parsed.kind === "BROADCAST" || parsed.kind === "NEWSLETTER") {
    return { error: "That is not a person's WhatsApp ID, so it cannot be linked to anyone." };
  }
  const key = whatsappIdKey(senderId);
  if (!key || !/^\d{6,}$/.test(key)) return { error: "That WhatsApp ID is not in a form that can be stored. Nothing was changed." };

  const member = await prisma.internalTeamMember.findUnique({
    where: { id: memberId },
    select: { id: true, name: true, phoneNumber: true, whatsappId: true },
  });
  if (!member) return { error: "That team member no longer exists." };
  if (member.whatsappId === key) return { linked: member.name };
  if (member.whatsappId) {
    return { error: `${member.name} already has WhatsApp ID ${member.whatsappId}. Change it on their edit page if this is really them.` };
  }
  const idConflict = await findWhatsAppIdConflict(key, member.id);
  if (idConflict) return { error: `${idConflict.name} already has that WhatsApp ID, so it cannot also be ${member.name}'s.` };

  try {
    await prisma.internalTeamMember.update({ where: { id: member.id }, data: { whatsappId: key } });
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "Someone already has that WhatsApp ID." };
    throw err;
  }
  await logIdentityChange(
    granted.session.userId,
    member.id,
    member.name,
    { phoneNumber: member.phoneNumber, whatsappId: null },
    { phoneNumber: member.phoneNumber, whatsappId: key },
    "chat-link",
  );
  revalidatePath(await projectPath("/team-members"));
  revalidatePath(await projectPath("/chat"), "layout");
  return { linked: member.name };
}

export async function toggleTeamMemberStatus(id: string): Promise<void> {
  await requireAccess("whatsapp.manage");
  const member = await prisma.internalTeamMember.findUniqueOrThrow({ where: { id } });
  await prisma.internalTeamMember.update({
    where: { id },
    data: { status: member.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" },
  });
  revalidatePath(await projectPath("/team-members"));
}

export interface DeleteTeamMemberResult {
  /** True when the row was kept and deactivated instead of removed, because it has history. */
  deactivated: boolean;
}

/**
 * Removes a team member, or deactivates them if removing would destroy history.
 *
 * `SupportActivity.teamMemberId` is SetNull, so a hard delete silently orphans every activity that
 * person ever recorded — their past work becomes unattributable, and the per-executive reports
 * quietly under-count for ever. That had already happened here: the two TEAM_MEMBER activity rows
 * in the live database have a null teamMemberId and no name to show, because the member was
 * deleted after the rows were written.
 *
 * So a member with history is deactivated instead, which is this project's stated
 * soft-delete-over-hard-delete rule and what the status field already exists for. Somebody added
 * by mistake, who has recorded nothing, is genuinely deleted — keeping a typo on the roster for
 * ever would be its own kind of mess.
 */
export async function deleteTeamMember(id: string): Promise<DeleteTeamMemberResult> {
  await requireAccess("whatsapp.manage");

  const activityCount = await prisma.supportActivity.count({ where: { teamMemberId: id } });
  if (activityCount > 0) {
    await prisma.internalTeamMember.update({ where: { id }, data: { status: "INACTIVE" } });
    revalidatePath(await projectPath("/team-members"));
    revalidatePath(await projectPath("/support-activity"));
    return { deactivated: true };
  }

  await prisma.internalTeamMember.delete({ where: { id } });
  revalidatePath(await projectPath("/team-members"));
  return { deactivated: false };
}

export interface LoginLinkState {
  error?: string;
  saved?: boolean;
}

/**
 * Link a roster member to the dashboard login they use (SUPPORT_ASSIGNMENT.md, GOOGLE_SHEETS.md §5).
 * Support Assignment's "My assignments" reads it, and Google Sheets attributes work done through the
 * app to the team member linked to the login that did it. It grants nothing, and matching WhatsApp
 * messages to people never looks at it. A login can be linked to one member per project; the login
 * must be able to enter it. Every change is recorded in System Logs, since attribution follows it.
 */
export async function linkTeamMemberLogin(memberId: string, _prev: LoginLinkState, formData: FormData): Promise<LoginLinkState> {
  const granted = await checkPermission("whatsapp.manage");
  if ("denied" in granted) return { error: granted.denied };
  const userId = String(formData.get("userId") ?? "").trim() || null;

  const member = await prisma.internalTeamMember.findUnique({ where: { id: memberId }, select: { id: true, name: true, userId: true } });
  if (!member) return { error: "That team member no longer exists." };
  if (member.userId === userId) return { saved: true };
  let loginName: string | null = null;
  if (userId) {
    const login = (await loginsForProject()).find((u) => u.id === userId);
    if (!login) return { error: "That login cannot enter this project, or is deactivated. Nothing was changed." };
    loginName = login.username;
    const other = await prisma.internalTeamMember.findFirst({ where: { userId, id: { not: memberId } }, select: { name: true } });
    if (other) return { error: `That login is already linked to ${other.name}. Unlink it there first.` };
  }
  await prisma.internalTeamMember.update({ where: { id: memberId }, data: { userId } });
  await logSystemEvent(
    "INFO",
    "team-members",
    userId ? `Team member ${member.name} linked to login ${loginName}` : `Team member ${member.name} unlinked from their login`,
    { previousUserId: member.userId, userId },
    { actorUserId: granted.session.userId, targetType: "InternalTeamMember", targetId: member.id },
  );
  revalidatePath(await projectPath(`/team-members/${memberId}/edit`));
  return { saved: true };
}
