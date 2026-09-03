import { prisma } from "@support-automation/db";
import { isForgeConfigured } from "@support-automation/forge-client";
import { runForgeKnowledgeSync } from "./forgeKnowledgeJob.js";
import { processOneResearchTask } from "./forgeResearchJob.js";

/**
 * The two Forge background loops, following the same overlap-guarded `setInterval` pattern as
 * every other job in this worker (`setInterval` does not await its callback, so each needs its
 * own boolean).
 */

/**
 * Re-reads the ISPDIGITAL repository on a slow cadence.
 *
 * Six hours, matching the AI analysis processor, because product documentation changes on the
 * scale of releases, not minutes — and because a full sync is dozens of model calls. On-demand
 * runs come through the dashboard's "Sync now" button as a `FORGE_SYNC_NOW` WorkerCommand, which
 * is how an operator gets a fresh read immediately after editing a guide.
 */
export function startForgeKnowledgeProcessor(intervalMs = 6 * 60 * 60_000): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    if (!isForgeConfigured()) return;
    running = true;
    runForgeKnowledgeSync()
      .then((result) => {
        if (result.ran && result.entriesCreated) {
          console.log(
            `[forge] learned ${result.entriesCreated} entries from ${result.documentsRead} document(s) and ${result.modulesRead} module(s)` +
              (result.entriesBlocked ? `, blocked ${result.entriesBlocked}` : ""),
          );
        }
      })
      .catch((err) => {
        console.error("[forge] unexpected error during knowledge sync", err);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
}

/**
 * Works through the queue of customer questions verified knowledge could not answer.
 *
 * Two minutes: fast enough that a gap discovered this morning is filled before the afternoon,
 * slow enough that a burst of unanswerable messages cannot turn into a burst of API spend. One
 * task per tick, and the job no-ops immediately when the queue is empty, which is the normal case.
 */
export function startForgeResearchProcessor(intervalMs = 2 * 60_000): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    if (!isForgeConfigured()) return;
    running = true;
    processOneResearchTask()
      .then((result) => {
        if (result.ran && result.outcome) {
          console.log(`[forge] research task ${result.taskId} → ${result.outcome}`);
        }
      })
      .catch((err) => {
        console.error("[forge] unexpected error researching a question", err);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
}

/**
 * Seeds ForgeSettings on boot so the dashboard always has a row to render, and records the
 * project when exactly one is in scope.
 *
 * Auto-selecting a single project is safe in a way auto-selecting from several would not be: with
 * one project there is no wrong choice to make. With more than one, an admin picks — learning
 * from the wrong product's repository would be silent and completely wrong.
 */
export async function ensureForgeSettings(): Promise<void> {
  if (!isForgeConfigured()) return;
  const settings = await prisma.forgeSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
  if (settings.projectId) return;

  try {
    const { ForgeClient, loadForgeConfigFromEnv } = await import("@support-automation/forge-client");
    const projects = await new ForgeClient(loadForgeConfigFromEnv()).listProjects();
    if (projects.length !== 1) return;
    await prisma.forgeSettings.update({
      where: { id: "global" },
      data: { projectId: projects[0]!.id, projectName: projects[0]!.name },
    });
    console.log(`[forge] linked to project "${projects[0]!.name}"`);
  } catch (err) {
    // Never fatal: Forge being unreachable at boot must not stop the worker starting.
    console.warn("[forge] could not discover projects at boot —", (err as Error).message);
  }
}
