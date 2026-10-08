"use server";

import { projectPath } from "@/server/projectPaths";
import { prisma } from "@/server/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isUniqueViolation } from "@/lib/prismaErrors";
import { checkPermission } from "@/server/authorize";

/**
 * Teams — the organisational groups members belong to (Support, Billing, Commercial...).
 *
 * Gated on the same keys as Internal Team Members: a Team is part of the roster, and splitting it
 * onto its own permission would let somebody manage Teams who cannot see who is in them.
 */

export interface TeamFormState {
  error?: string;
  success?: boolean;
}

interface TeamInput {
  name: string;
  code: string | null;
  description: string | null;
  status: "ACTIVE" | "DISABLED";
}

function readTeamForm(formData: FormData): TeamInput | { error: string } {
  const name = String(formData.get("name") ?? "").trim().replace(/\s+/g, " ");
  // A code is an identifier people type into filters and exports, so it is normalised to one form.
  const code = String(formData.get("code") ?? "").trim().toUpperCase().replace(/\s+/g, "_") || null;
  const description = String(formData.get("description") ?? "").trim() || null;
  const status = formData.get("status") === "DISABLED" ? "DISABLED" : "ACTIVE";
  if (!name) return { error: "Give the team a name." };
  if (name.length > 80) return { error: "Keep the team name under 80 characters." };
  if (code && !/^[A-Z0-9_-]{1,24}$/.test(code)) {
    return { error: "A team code is up to 24 letters, digits, dashes or underscores — e.g. SUPPORT." };
  }
  return { name, code, description, status };
}

/**
 * The unique index is case-sensitive, but "Support team" and "Support Team" are the same Team to
 * everyone reading a dropdown — two of them would split one team's members across two report rows.
 */
async function findClash(input: TeamInput, excludeId?: string): Promise<string | null> {
  const clash = await prisma.team.findFirst({
    where: {
      id: excludeId ? { not: excludeId } : undefined,
      OR: [
        { name: { equals: input.name, mode: "insensitive" } },
        ...(input.code ? [{ code: { equals: input.code, mode: "insensitive" as const } }] : []),
      ],
    },
    select: { name: true, code: true },
  });
  if (!clash) return null;
  return clash.name.toLowerCase() === input.name.toLowerCase()
    ? `There is already a team called ${clash.name}.`
    : `${clash.name} already uses the code ${clash.code}.`;
}

export async function createTeam(_prev: TeamFormState, formData: FormData): Promise<TeamFormState> {
  const granted = await checkPermission("whatsapp.manage");
  if ("denied" in granted) return { error: granted.denied };
  const input = readTeamForm(formData);
  if ("error" in input) return input;
  const clash = await findClash(input);
  if (clash) return { error: clash };
  try {
    await prisma.team.create({ data: input });
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "A team with that name or code already exists." };
    throw err;
  }
  revalidatePath(await projectPath("/teams"));
  return { success: true };
}

export async function updateTeam(id: string, _prev: TeamFormState, formData: FormData): Promise<TeamFormState> {
  const granted = await checkPermission("whatsapp.manage");
  if ("denied" in granted) return { error: granted.denied };
  const input = readTeamForm(formData);
  if ("error" in input) return input;
  const clash = await findClash(input, id);
  if (clash) return { error: clash };
  try {
    await prisma.team.update({ where: { id }, data: input });
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "A team with that name or code already exists." };
    throw err;
  }
  revalidatePath(await projectPath("/teams"));
  revalidatePath(await projectPath("/team-members"));
  redirect(await projectPath(`/teams/${id}`));
}

export interface TeamActionResult {
  ok: boolean;
  message: string;
}

/**
 * Disabling hides a Team from the member form's dropdown and nothing else: its members keep it,
 * and every report can still filter on it.
 */
export async function setTeamStatus(id: string, status: "ACTIVE" | "DISABLED"): Promise<TeamActionResult> {
  const granted = await checkPermission("whatsapp.manage");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const team = await prisma.team.update({ where: { id }, data: { status }, select: { name: true } });
  revalidatePath(await projectPath("/teams"));
  revalidatePath(await projectPath("/team-members"));
  return {
    ok: true,
    message:
      status === "DISABLED"
        ? `${team.name} disabled. Its members keep it, and reports can still show it.`
        : `${team.name} enabled.`,
  };
}

/**
 * Deletes a Team only when nothing has ever pointed at it.
 *
 * A Team with members now must have them moved first — deleting it would silently drop them into
 * "no team". A Team with only PAST members is refused too: those memberships are what make an
 * earlier month's report say who was in it then, and a delete would take them with it.
 */
export async function deleteTeam(id: string): Promise<TeamActionResult> {
  const granted = await checkPermission("whatsapp.manage");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const [current, history, team] = await Promise.all([
    prisma.internalTeamMember.count({ where: { teamId: id } }),
    prisma.teamMembership.count({ where: { teamId: id } }),
    prisma.team.findUnique({ where: { id }, select: { name: true } }),
  ]);
  if (!team) return { ok: false, message: "That team no longer exists." };
  if (current > 0) {
    return {
      ok: false,
      message: `This team has ${current} assigned member${current === 1 ? "" : "s"}. Reassign or remove the members before deleting this team.`,
    };
  }
  if (history > 0) {
    return {
      ok: false,
      message: `${team.name} has past members, and reports for those periods still use it. Disable it instead — it disappears from the member form and its history stays.`,
    };
  }
  await prisma.team.delete({ where: { id } });
  revalidatePath(await projectPath("/teams"));
  return { ok: true, message: `${team.name} deleted.` };
}
