"use server";

import { projectPath } from "@/server/projectPaths";
import { prisma } from "@/server/db";
import { revalidatePath } from "next/cache";

import { ForgeClient, isForgeConfigured, loadForgeConfigFromEnv } from "@support-automation/forge-client";
import { checkPermission, requireAccess } from "@/server/authorize";

/**
 * Settings and on-demand actions for the Softify Forge integration — the source of the assistant's
 * knowledge about ISPDIGITAL itself.
 *
 * Like every other worker-dependent action in this app, "Sync now" writes a `WorkerCommand` and
 * returns; the worker owns the actual work. Nothing here talks to the worker over HTTP.
 */

async function getOrCreate() {
  return prisma.forgeSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
}

async function revalidate() {
  revalidatePath(await projectPath("/integrations/forge"));
  revalidatePath(await projectPath("/ai-learning"));
  revalidatePath(await projectPath("/ai-learning/knowledge-base/review"));
}

export async function updateForgeSettings(formData: FormData): Promise<void> {
  await requireAccess("ai_learning.manage", "PRODUCT_KNOWLEDGE_FORGE");
  await getOrCreate();

  const projectId = String(formData.get("projectId") ?? "").trim() || null;
  // Store the name alongside the id so the page can say "ispdigital" without a Forge round trip
  // on every render — and still says something sensible when Forge is unreachable.
  const projectName = String(formData.get("projectName") ?? "").trim() || null;

  await prisma.forgeSettings.update({
    where: { id: "global" },
    data: {
      enabled: formData.get("enabled") === "on",
      syncUserGuides: formData.get("syncUserGuides") === "on",
      syncModuleGuides: formData.get("syncModuleGuides") === "on",
      researchUnanswered: formData.get("researchUnanswered") === "on",
      autoVerifyUserGuides: formData.get("autoVerifyUserGuides") === "on",
      ...(projectId ? { forgeProjectId: projectId, forgeProjectName: projectName } : {}),
    },
  });
  await revalidate();
}

export interface ForgeConnectionCheck {
  ok: boolean;
  identity?: { name: string; email: string; apiVersion: string };
  projects?: Array<{ id: string; name: string }>;
  error?: string;
}

/**
 * Confirms the credentials work and lists what they can see, so an admin picking a project is
 * choosing from reality rather than typing an id.
 */
export async function checkForgeConnection(): Promise<ForgeConnectionCheck> {
  const granted = await checkPermission("ai_learning.manage", "PRODUCT_KNOWLEDGE_FORGE");
  if ("denied" in granted) return { ok: false, error: granted.denied };
  if (!isForgeConfigured()) {
    return { ok: false, error: "Forge is not configured. Set FORGE_API_KEY and FORGE_API_URL, then restart." };
  }
  try {
    const client = new ForgeClient(loadForgeConfigFromEnv());
    const [identity, projects] = await Promise.all([client.getIdentity(), client.listProjects()]);
    return {
      ok: true,
      identity: { name: identity.name, email: identity.email, apiVersion: identity.apiVersion },
      projects: projects.map((project) => ({ id: project.id, name: project.name })),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export interface ForgeSyncRequest {
  queued: boolean;
  error?: string;
}

/**
 * Queues an immediate re-read of the repository.
 *
 * Deduplicated against a sync already in flight: a full pass is dozens of model calls, and an
 * impatient double-click should cost nothing.
 */
export async function requestForgeSync(): Promise<ForgeSyncRequest> {
  const granted = await checkPermission("ai_learning.manage", "PRODUCT_KNOWLEDGE_FORGE");
  if ("denied" in granted) return { queued: false, error: granted.denied };
  const settings = await getOrCreate();
  if (!settings.enabled) return { queued: false, error: "Turn the integration on first." };
  if (!settings.forgeProjectId) return { queued: false, error: "Choose which Forge project to learn from first." };

  const inFlight = await prisma.workerCommand.findFirst({
    where: { type: "FORGE_SYNC_NOW", status: { in: ["PENDING", "PROCESSING"] } },
  });
  if (inFlight) return { queued: true };

  await prisma.workerCommand.create({ data: { type: "FORGE_SYNC_NOW" } });
  await revalidate();
  return { queued: true };
}

export interface ForgeSyncStatus {
  status: "IDLE" | "PENDING" | "DONE" | "FAILED";
  result?: { documentsRead?: number; modulesRead?: number; entriesCreated?: number; entriesBlocked?: number };
  error?: string;
}

/** Polled by the settings page while a sync runs — the same shape as the roster fetch. */
export async function readForgeSyncStatus(): Promise<ForgeSyncStatus> {
  const granted = await checkPermission("ai_learning.view", "PRODUCT_KNOWLEDGE_FORGE");
  if ("denied" in granted) return { status: "FAILED", error: granted.denied };
  const command = await prisma.workerCommand.findFirst({
    where: { type: "FORGE_SYNC_NOW" },
    orderBy: { createdAt: "desc" },
  });
  if (!command) return { status: "IDLE" };
  if (command.status === "PENDING" || command.status === "PROCESSING") return { status: "PENDING" };
  if (command.status === "FAILED") {
    return { status: "FAILED", error: (command.result as { error?: string } | null)?.error ?? "The sync failed." };
  }
  return { status: "DONE", result: (command.result as ForgeSyncStatus["result"]) ?? {} };
}
