import { prisma } from "../db.js";
import { resolveAiClient, type AiClient } from "@support-automation/ai-client";
import { derivePatternSignature } from "@support-automation/engine";
import {
  ForgeClient,
  ForgeRequestError,
  checkKnowledgeEntrySafety,
  isForgeConfigured,
  loadForgeConfigFromEnv,
} from "@support-automation/forge-client";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { parseKnowledgeRecords } from "../knowledge/groupKnowledgePrompt.js";
import { buildResearchPrompt, selectModuleForQuestion } from "./forgePrompts.js";
import { getForgeSettings, readModuleSources } from "./forgeKnowledgeJob.js";
import { getAiSettings } from "../ai/settings.js";

/**
 * The "if the guides do not have the answer, go and read the code" path.
 *
 * A customer asks something. The rule engine misses, the AI fallback finds no verified knowledge
 * covering it, and the conversation goes to a human — that part is unchanged and immediate. This
 * job then takes the question the system could not answer and researches it against the
 * ISPDIGITAL source, so the *next* customer to ask gets an answer.
 *
 * It deliberately runs after the handoff rather than in front of the customer, for three reasons,
 * in increasing order of importance:
 *
 *  1. Reading source takes several API round trips and many seconds; a customer waiting on
 *     WhatsApp does not.
 *  2. It would spend a model call on every unanswerable message, including the ones that are not
 *     really questions.
 *  3. It would put raw source code into the same prompt that drafts a customer-facing reply.
 *     That is precisely the arrangement the disclosure requirement exists to prevent. Here, the
 *     code is read in a prompt whose only output goes to a review queue, and a human decides
 *     whether the result is fit to say to anyone.
 *
 * Questions are deduplicated by keyword signature, so a thing fifty customers ask becomes one
 * research task with `askedCount` at fifty — which is also the priority order for which gap to
 * close first.
 */

/** Give up after this many attempts; a question the code cannot answer will not start answering. */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30 * 60_000;

/**
 * Records that a customer question could not be answered.
 *
 * Called from the AI fallback layer as a fire-and-forget side effect, in the same style as the
 * escalation and support-activity hooks: its own error boundary, and a true no-op when the
 * feature is off. Never throws into the caller.
 */
export async function recordUnansweredQuestion(input: {
  question: string;
  fallbackDecisionId: string | null;
}): Promise<void> {
  const trimmed = input.question.trim();
  // Very short messages ("ok", "hello?") are not researchable questions; queuing them would fill
  // the queue with noise and spend real money on it.
  if (trimmed.length < 12) return;

  const settings = await getForgeSettings();
  if (!settings.enabled || !settings.researchUnanswered || !settings.forgeProjectId) return;

  // `patternKey` is the stable, word-order-independent key — the same one the pattern detector
  // and AI rule drafting already deduplicate on, so "how do I void an invoice" asked in fifty
  // groups is one research task here too. Empty means the message had no distinctive words at
  // all, which is not a researchable question.
  const { patternKey } = derivePatternSignature(trimmed);
  if (!patternKey) return;

  try {
    await prisma.forgeResearchTask.create({
      data: { question: trimmed, signature: patternKey, fallbackDecisionId: input.fallbackDecisionId },
    });
  } catch (err: any) {
    if (err?.code !== "P2002") throw err;
    // Asked before. Bump the count — that is the whole point of deduplicating on signature — but
    // do not resurrect a task that already concluded the code has no answer.
    await prisma.forgeResearchTask.updateMany({
      where: { signature: patternKey, status: { in: ["PENDING", "PROCESSING", "ANSWERED", "FAILED"] } },
      data: { askedCount: { increment: 1 } },
    });
  }
}

/** Atomically claims the most-asked due task, or null if none are waiting. */
async function claimNextTask() {
  const candidate = await prisma.forgeResearchTask.findFirst({
    where: { status: "PENDING", scheduledAt: { lte: new Date() } },
    // Most-asked first: the gap hurting the most customers gets closed first.
    orderBy: [{ askedCount: "desc" }, { createdAt: "asc" }],
  });
  if (!candidate) return null;

  const claim = await prisma.forgeResearchTask.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: { status: "PROCESSING", startedAt: new Date(), attemptCount: { increment: 1 } },
  });
  if (claim.count === 0) return null;
  return prisma.forgeResearchTask.findUniqueOrThrow({ where: { id: candidate.id } });
}

export interface ForgeResearchResult {
  ran: boolean;
  skipped?: string;
  taskId?: string;
  outcome?: "ANSWERED" | "NO_ANSWER" | "FAILED";
  entriesCreated?: number;
  entriesBlocked?: number;
}

/** `clientOverride` is the test-only seam every other AI job here uses. */
export async function processOneResearchTask(clientOverride?: AiClient): Promise<ForgeResearchResult> {
  if (!isForgeConfigured()) return { ran: false, skipped: "FORGE_NOT_CONFIGURED" };

  const settings = await getForgeSettings();
  if (!settings.enabled || !settings.researchUnanswered || !settings.forgeProjectId) {
    return { ran: false, skipped: "RESEARCH_DISABLED" };
  }

  const aiSettings = await getAiSettings();
  if (!aiSettings.aiEngineEnabled) return { ran: false, skipped: "AI_ENGINE_DISABLED" };

  const task = await claimNextTask();
  if (!task) return { ran: false, skipped: "QUEUE_EMPTY" };

  const ai = clientOverride ?? (await resolveAiClient("LEARNING", prisma));
  if (!ai) {
    await releaseForRetry(task.id, task.attemptCount, "The AI provider was unavailable.");
    return { ran: true, taskId: task.id, skipped: "AI_UNAVAILABLE" };
  }

  const projectId = settings.forgeProjectId;
  const forge = new ForgeClient(loadForgeConfigFromEnv());

  try {
    const modules = await forge.listKnowledgeModules(projectId);
    const module = selectModuleForQuestion(task.question, modules);
    if (!module) {
      // Nothing in the product map resembles the question. That is a real answer — this question
      // is probably not about the product at all — so it is settled, not retried.
      await prisma.forgeResearchTask.update({
        where: { id: task.id },
        data: { status: "NO_ANSWER", completedAt: new Date(), error: "No product area matched this question." },
      });
      return { ran: true, taskId: task.id, outcome: "NO_ANSWER" };
    }

    const sources = await readModuleSources(forge, projectId, module);
    if (sources.length === 0) {
      await prisma.forgeResearchTask.update({
        where: { id: task.id },
        data: {
          status: "NO_ANSWER",
          moduleSlug: module.slug,
          completedAt: new Date(),
          error: "The files for that product area could not be read.",
        },
      });
      return { ran: true, taskId: task.id, outcome: "NO_ANSWER" };
    }

    const prompt = buildResearchPrompt({ question: task.question, moduleName: module.name, sources });
    const completion = await ai.complete({
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      maxTokens: prompt.maxTokens,
      temperature: prompt.temperature,
    });

    const entries = parseKnowledgeRecords(completion.text ?? "");
    const label = `ISPDIGITAL research — ${module.name}`;
    let created = 0;
    let blocked = 0;
    let firstItemId: string | null = null;

    for (const entry of entries.slice(0, 2)) {
      const verdict = checkKnowledgeEntrySafety(entry);
      if (!verdict.safe) {
        blocked += 1;
        await logSystemEvent("WARN", "forge", "Blocked a researched answer that would have exposed internals", {
          question: task.question.slice(0, 120),
          violations: verdict.violations.join(", "),
        });
        continue;
      }
      const item = await prisma.aiKnowledgeItem.create({
        data: {
          title: entry.title,
          category: entry.category,
          question: entry.question ?? task.question,
          answer: entry.answer,
          procedure: entry.procedure,
          module: module.name,
          software: "ISPDIGITAL",
          source: "FORGE_RESEARCH",
          sourceLabel: label,
          confidence: entry.confidence,
          aiGenerated: true,
          // Never auto-verified. This answer exists because a model read source code; a human
          // decides whether it is fit to say to a customer.
          humanVerified: false,
        },
      });
      firstItemId ??= item.id;
      created += 1;
    }

    await prisma.forgeResearchTask.update({
      where: { id: task.id },
      data: {
        status: created > 0 ? "ANSWERED" : "NO_ANSWER",
        moduleSlug: module.slug,
        producedItemId: firstItemId,
        completedAt: new Date(),
        error:
          created > 0
            ? null
            : blocked > 0
              ? "An answer was found but could not be shared without exposing internals."
              : "The code for that area did not answer this question.",
      },
    });

    return {
      ran: true,
      taskId: task.id,
      outcome: created > 0 ? "ANSWERED" : "NO_ANSWER",
      entriesCreated: created,
      entriesBlocked: blocked,
    };
  } catch (err) {
    const message =
      err instanceof ForgeRequestError ? err.message : "Could not read the repository while researching this question.";
    await releaseForRetry(task.id, task.attemptCount, message);
    return { ran: true, taskId: task.id, outcome: "FAILED", skipped: message };
  }
}

/** Back to PENDING for another try, or terminally FAILED once the attempts are spent. */
async function releaseForRetry(taskId: string, attemptCount: number, error: string): Promise<void> {
  const exhausted = attemptCount >= MAX_ATTEMPTS;
  await prisma.forgeResearchTask.update({
    where: { id: taskId },
    data: exhausted
      ? { status: "FAILED", error, completedAt: new Date() }
      : { status: "PENDING", error, scheduledAt: new Date(Date.now() + RETRY_DELAY_MS) },
  });
}
