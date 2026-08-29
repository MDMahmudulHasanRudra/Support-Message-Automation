"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";

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

  const alreadyOnRoster = new Set(existing.map((m) => m.phoneNumber));
  const candidatePhones = senders.map((s) => s.senderPhone).filter((phone) => !alreadyOnRoster.has(phone));
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
    .filter((s) => !alreadyOnRoster.has(s.senderPhone))
    .map((s) => ({
      phoneNumber: s.senderPhone,
      suggestedName: nameByPhone.get(s.senderPhone) ?? null,
      messageCount: s._count.senderPhone,
      lastSeenAt: s._max.timestampWa ?? new Date(0),
    }));
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

  const result = await prisma.internalTeamMember.createMany({
    data: parsed.map((entry) => ({
      name: entry.name,
      phoneNumber: entry.phoneNumber,
      role,
      department,
      status: "ACTIVE" as const,
    })),
    // phoneNumber is @unique; anyone already on the roster is skipped instead of failing the batch.
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
