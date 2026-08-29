"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { normalizePhoneNumber } from "@support-automation/shared";

export async function createTeamMember(formData: FormData): Promise<void> {
  await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  const phoneNumber = String(formData.get("phoneNumber") ?? "").trim();
  const role = String(formData.get("role") ?? "").trim();
  const department = String(formData.get("department") ?? "").trim() || null;

  if (!name || !phoneNumber || !role) {
    throw new Error("Name, phone number, and role are required.");
  }

  await prisma.internalTeamMember.create({
    data: { name, phoneNumber, role, department, status: "ACTIVE" },
  });
  revalidatePath("/team-members");
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
  await requireSession();

  const [senders, existing] = await Promise.all([
    prisma.message.groupBy({
      by: ["senderPhone"],
      where: { groupId },
      _count: { senderPhone: true },
      _max: { timestampWa: true },
      orderBy: { _count: { senderPhone: "desc" } },
      take: 100,
    }),
    prisma.internalTeamMember.findMany({ select: { phoneNumber: true } }),
  ]);

  // Compared as digits, not as raw strings: the same person is "+8801700000123" on the roster and
  // "8801700000123" in a message row, and a raw comparison would offer an existing colleague as a
  // new candidate — then add them a second time.
  const alreadyOnRoster = new Set(
    existing.map((m) => normalizePhoneNumber(m.phoneNumber)).filter((d): d is string => d !== null),
  );
  const isOnRoster = (phone: string) => {
    const digits = normalizePhoneNumber(phone);
    return digits !== null && alreadyOnRoster.has(digits);
  };
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
  await requireSession();

  const inFlight = await prisma.workerCommand.findFirst({
    where: {
      type: "GET_GROUP_PARTICIPANTS",
      status: { in: ["PENDING", "PROCESSING"] },
      // Prisma cannot filter inside Json on every connector, so the narrow type filter plus the
      // per-group check below is done in application code.
    },
    orderBy: { createdAt: "desc" },
  });
  const inFlightGroupId = (inFlight?.payload as { groupId?: string } | null)?.groupId;
  if (inFlight && inFlightGroupId === groupId) return;

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
  await requireSession();

  const command = await prisma.workerCommand.findFirst({
    where: { type: "GET_GROUP_PARTICIPANTS" },
    orderBy: { createdAt: "desc" },
  });

  const commandGroupId = (command?.payload as { groupId?: string } | null)?.groupId;
  if (!command || commandGroupId !== groupId) return { status: "IDLE", participants: [] };

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

  const raw = (command.result as { participants?: Array<{ phoneNumber?: string; name?: string | null; isSelf?: boolean }> } | null)
    ?.participants;
  if (!Array.isArray(raw)) return { status: "IDLE", participants: [] };

  const existing = await prisma.internalTeamMember.findMany({ select: { phoneNumber: true } });
  const onRoster = new Set(
    existing.map((m) => normalizePhoneNumber(m.phoneNumber)).filter((d): d is string => d !== null),
  );

  const participants = raw
    // The signed-in account is the business's own WhatsApp line, never a colleague to add.
    .filter((p) => p?.phoneNumber && !p.isSelf)
    .map((p) => ({
      phoneNumber: String(p.phoneNumber),
      suggestedName: p.name ?? null,
      messageCount: 0,
      lastSeenAt: new Date(0),
    }))
    .filter((p) => {
      const digits = normalizePhoneNumber(p.phoneNumber);
      return digits !== null && !onRoster.has(digits);
    });

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
  await requireSession();

  const role = String(formData.get("role") ?? "").trim() || "Support";
  const department = String(formData.get("department") ?? "").trim() || null;
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
  const existing = await prisma.internalTeamMember.findMany({ select: { phoneNumber: true } });
  const seen = new Set(
    existing.map((m) => normalizePhoneNumber(m.phoneNumber)).filter((d): d is string => d !== null),
  );

  const toCreate: Array<{ name: string; phoneNumber: string }> = [];
  for (const entry of parsed) {
    const digits = normalizePhoneNumber(entry.phoneNumber);
    if (digits === null || seen.has(digits)) continue;
    seen.add(digits);
    toCreate.push({ name: entry.name, phoneNumber: entry.phoneNumber });
  }

  if (toCreate.length === 0) {
    return { error: "Everyone selected is already on the roster." };
  }

  const result = await prisma.internalTeamMember.createMany({
    data: toCreate.map((entry) => ({
      name: entry.name,
      phoneNumber: entry.phoneNumber,
      role,
      department,
      status: "ACTIVE" as const,
    })),
    skipDuplicates: true,
  });

  revalidatePath("/team-members");
  return { addedCount: result.count };
}

export async function updateTeamMember(id: string, formData: FormData): Promise<void> {
  await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  const phoneNumber = String(formData.get("phoneNumber") ?? "").trim();
  const role = String(formData.get("role") ?? "").trim();
  const department = String(formData.get("department") ?? "").trim() || null;

  if (!name || !phoneNumber || !role) {
    throw new Error("Name, phone number, and role are required.");
  }

  await prisma.internalTeamMember.update({
    where: { id },
    data: { name, phoneNumber, role, department },
  });
  revalidatePath("/team-members");
  redirect("/team-members");
}

export async function toggleTeamMemberStatus(id: string): Promise<void> {
  await requireSession();
  const member = await prisma.internalTeamMember.findUniqueOrThrow({ where: { id } });
  await prisma.internalTeamMember.update({
    where: { id },
    data: { status: member.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" },
  });
  revalidatePath("/team-members");
}

export async function deleteTeamMember(id: string): Promise<void> {
  await requireSession();
  await prisma.internalTeamMember.delete({ where: { id } });
  revalidatePath("/team-members");
}
