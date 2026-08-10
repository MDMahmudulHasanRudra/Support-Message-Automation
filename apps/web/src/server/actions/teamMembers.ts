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
