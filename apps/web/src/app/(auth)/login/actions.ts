"use server";

import { redirect } from "next/navigation";
import { prisma } from "@support-automation/db";
import { createSession, verifyPassword } from "@/server/auth";

export interface LoginState {
  error?: string;
}

export async function login(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!username || !password) {
    return { error: "Username and password are required." };
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return { error: "Invalid username or password." };
  }

  await createSession(user.id);
  redirect("/overview");
}
