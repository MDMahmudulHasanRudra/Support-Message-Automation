"use server";

import { projectPath } from "@/server/projectPaths";
import { redirect } from "next/navigation";
import { destroySession } from "@/server/auth";

export async function logout(): Promise<void> {
  await destroySession();
  redirect(await projectPath("/login"));
}
