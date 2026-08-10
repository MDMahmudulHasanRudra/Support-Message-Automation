"use server";

import { redirect } from "next/navigation";
import { prisma } from "@support-automation/db";
import { createSession, verifyPassword } from "@/server/auth";

export interface LoginState {
  error?: string;
}

export async function login(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return { error: "Invalid email or password." };
  }

  await createSession(user.id);
  redirect("/overview");
}
