import { projectHasFeature } from "../project/features.js";
import { prisma } from "../db.js";
import { resolveAiClient, type AiClient } from "@support-automation/ai-client";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { buildGroupKnowledgePrompt, parseKnowledgeRecords } from "./groupKnowledgePrompt.js";
import { getAiSettings } from "../ai/settings.js";

/**
 * "Learn from Conversations" — the admin-driven half of the knowledge builder.
 *
 * groupKnowledgeJob.ts runs on its own schedule, picks the group, picks the window, and writes
 * straight into the knowledge base unverified. This one inverts all three: an admin chooses the
 * groups and the time range, presses a button, and gets back a list of candidates to accept or
 * throw away. Same extraction prompt, same parser, same redaction — only the triggering and the
 * destination differ, which is why this imports from groupKnowledgePrompt.ts rather than
 * restating it.
 *
 * THREE THINGS IT MUST NEVER DO, each of which would break the background builder or the
 * knowledge base:
 *   1. Write WhatsAppGroup.knowledgeBuiltAt / knowledgeBuiltThroughAt. That pair is the other
 *      job's incremental watermark. Advancing it here would make the scheduled builder skip
 *      conversations nobody has actually learned from — silently, and permanently.
 *   2. Write AiKnowledgeItem. Candidates are proposals; only an explicit human approval in the
 *      dashboard creates a knowledge entry.
 *   3. Touch anything outside these tables. It reads Message rows and writes candidates.
 *
 * One group per tick, so a ten-group run is ten short ticks rather than one long one that holds
 * the loop open and risks a shutdown mid-flight.
 */

/** The same per-run message ceiling the scheduled builder uses. */
const MAX_MESSAGES_PER_GROUP = 400;
/** Below this the model is extrapolating rather than extracting — groupKnowledgeJob's own floor. */
const MIN_CONFIDENCE_TO_STORE = 60;
/** One group cannot flood a run with proposals. */
const MAX_CANDIDATES_PER_GROUP = 8;
/** Fewer than this in the window and there is not enough conversation to draw anything from. */
const MIN_MESSAGES_TO_ANALYSE = 5;

export interface ConversationAnalysisTickResult {
  ran: boolean;
  runId?: string;
  groupId?: string;
  created?: number;
  skipped?: string;
}

/** `clientOverride` is a test-only seam, mirroring groupKnowledgeJob's own. */
export async function processOneConversationAnalysisStep(
  clientOverride?: AiClient,
): Promise<ConversationAnalysisTickResult> {
  // Entitlement (MULTI_PROJECT_PLAN.md section 9): queued runs wait, untouched, until it is back on.
  if (!(await projectHasFeature("CONVERSATION_LEARNING"))) return { ran: false, skipped: "FEATURE_DISABLED" };

  // Oldest first, and RUNNING before QUEUED is unnecessary — createdAt ordering already keeps a
  // run that has started ahead of one queued after it, so runs finish in the order they were asked for.
  const run = await prisma.conversationAnalysisRun.findFirst({
    where: { status: { in: ["QUEUED", "RUNNING"] } },
    orderBy: { createdAt: "asc" },
  });
  if (!run) return { ran: false, skipped: "NO_RUNS" };

  if (run.status === "QUEUED") {
    // Claim-style: only one tick can move a run out of QUEUED.
    const claimed = await prisma.conversationAnalysisRun.updateMany({
      where: { id: run.id, status: "QUEUED" },
      data: { status: "RUNNING", startedAt: new Date(), groupsTotal: run.groupIds.length },
    });
    if (claimed.count === 0) return { ran: false, skipped: "CLAIMED_ELSEWHERE" };
  }

  // groupsDone doubles as the cursor into the (immutable) groupIds array.
  const groupId = run.groupIds[run.groupsDone];
  if (!groupId) {
    await finishRun(run.id);
    return { ran: false, runId: run.id, skipped: "ALREADY_COMPLETE" };
  }

  // The engine switch is the one gate that genuinely applies: with it off there is no model to
  // ask. `knowledgeFromChatEnabled` deliberately is NOT checked — that setting governs whether the
  // scheduled builder may go off and read conversations unprompted, which is a different question
  // from whether an admin may analyse groups they have just selected by hand.
  const aiSettings = await getAiSettings();
  if (!aiSettings.aiEngineEnabled) {
    await failRun(run.id, "The AI Engine master switch is off.");
    return { ran: false, runId: run.id, skipped: "AI_ENGINE_DISABLED" };
  }

  const client = clientOverride ?? (await resolveAiClient("LEARNING", prisma));
  if (!client) {
    await failRun(run.id, "No provider is assigned to the Learning job, or it is disabled.");
    return { ran: false, runId: run.id, skipped: "NO_AI_CLIENT" };
  }

  let created = 0;
  let stepError: string | null = null;
  try {
    created = await analyseOneGroup({
      runId: run.id,
      groupId,
      rangeKind: run.rangeKind,
      rangeStart: run.rangeStart,
      rangeEnd: run.rangeEnd,
      messageLimit: run.messageLimit,
      client,
    });
  } catch (err) {
    // A group that fails does not fail the run: the other groups' candidates are worth keeping,
    // matching KnowledgeImport's PARTIAL semantics.
    stepError = (err as Error).message.slice(0, 500);
    await logSystemEvent("WARN", "knowledge-builder", "Conversation analysis failed for one group", {
      runId: run.id,
      groupId,
      error: stepError,
    });
  }

  const advanced = await prisma.conversationAnalysisRun.update({
    where: { id: run.id },
    data: {
      groupsDone: { increment: 1 },
      candidatesCreated: { increment: created },
      ...(stepError ? { error: stepError } : {}),
    },
    select: { groupsDone: true, groupsTotal: true },
  });

  if (advanced.groupsDone >= advanced.groupsTotal) {
    await finishRun(run.id);
  }

  return { ran: true, runId: run.id, groupId, created };
}

async function finishRun(runId: string): Promise<void> {
  const run = await prisma.conversationAnalysisRun.findUnique({
    where: { id: runId },
    select: { error: true, candidatesCreated: true },
  });
  await prisma.conversationAnalysisRun.update({
    where: { id: runId },
    data: {
      // "Some groups failed but we kept what the others produced" is a real, distinct outcome and
      // is reported as such rather than as a plain success.
      status: run?.error ? "PARTIAL" : "COMPLETE",
      completedAt: new Date(),
    },
  });
  await logSystemEvent("INFO", "knowledge-builder", "Conversation analysis finished", {
    runId,
    candidatesCreated: run?.candidatesCreated ?? 0,
  });
}

async function failRun(runId: string, error: string): Promise<void> {
  await prisma.conversationAnalysisRun.update({
    where: { id: runId },
    data: { status: "FAILED", error, completedAt: new Date() },
  });
}

/** Reads one group's messages in the run's window and turns them into candidates. */
async function analyseOneGroup(params: {
  runId: string;
  groupId: string;
  rangeKind: "LATEST_MESSAGES" | "LAST_24_HOURS" | "LAST_7_DAYS" | "CUSTOM";
  rangeStart: Date | null;
  rangeEnd: Date | null;
  messageLimit: number | null;
  client: AiClient;
}): Promise<number> {
  const group = await prisma.whatsAppGroup.findUnique({
    where: { id: params.groupId },
    select: { id: true, name: true },
  });
  if (!group) return 0;

  const window = resolveWindow(params.rangeKind, params.rangeStart, params.rangeEnd);
  const take = Math.min(params.messageLimit ?? MAX_MESSAGES_PER_GROUP, MAX_MESSAGES_PER_GROUP);

  // LATEST_MESSAGES wants the newest N, so it reads descending and flips back; every other range
  // is bounded by time and reads in conversation order directly.
  const messages =
    params.rangeKind === "LATEST_MESSAGES"
      ? (
          await prisma.message.findMany({
            where: { groupId: group.id },
            orderBy: { timestampWa: "desc" },
            take,
            select: { body: true, timestampWa: true, isFromTeamMember: true },
          })
        ).reverse()
      : await prisma.message.findMany({
          where: {
            groupId: group.id,
            timestampWa: { gte: window.start, ...(window.end ? { lte: window.end } : {}) },
          },
          orderBy: { timestampWa: "asc" },
          take,
          select: { body: true, timestampWa: true, isFromTeamMember: true },
        });

  if (messages.length < MIN_MESSAGES_TO_ANALYSE) return 0;

  const prompt = buildGroupKnowledgePrompt({
    groupName: group.name,
    lines: messages.map((m) => ({
      at: m.timestampWa,
      // Reduced to a role before it reaches the model, exactly as the scheduled builder does —
      // no customer name or number can be copied into a candidate.
      speaker: m.isFromTeamMember ? "SUPPORT" : "CUSTOMER",
      isTeamMember: m.isFromTeamMember,
      body: m.body,
    })),
  });

  const completion = await params.client.complete(prompt);
  const extracted = parseKnowledgeRecords(completion.text)
    .filter((entry) => entry.confidence >= MIN_CONFIDENCE_TO_STORE)
    .slice(0, MAX_CANDIDATES_PER_GROUP);
  if (extracted.length === 0) return 0;

  // Don't propose what the knowledge base already says. Read-only against AiKnowledgeItem: the
  // same cheap exact-title check the scheduled builder uses for its own dedup, applied here to
  // avoid handing a reviewer a list of things they already approved once.
  const existing = await prisma.aiKnowledgeItem.findMany({
    where: { sourceGroupId: group.id, title: { in: extracted.map((e) => e.title) } },
    select: { title: true },
  });
  const known = new Set(existing.map((item) => item.title));

  // Also skip anything this same run already proposed for this group, so a re-run of a failed
  // group cannot double up.
  const alreadyProposed = await prisma.conversationCandidate.findMany({
    where: { runId: params.runId, groupId: group.id, title: { in: extracted.map((e) => e.title) } },
    select: { title: true },
  });
  alreadyProposed.forEach((c) => known.add(c.title));

  const fresh = extracted.filter((entry) => !known.has(entry.title));
  if (fresh.length === 0) return 0;

  await prisma.conversationCandidate.createMany({
    data: fresh.map((entry) => ({
      runId: params.runId,
      groupId: group.id,
      groupName: group.name,
      title: entry.title,
      category: entry.category,
      question: entry.question,
      answer: entry.answer,
      procedure: entry.procedure,
      module: entry.module,
      confidence: entry.confidence,
    })),
  });

  return fresh.length;
}

/** Turns the stored intent into an actual window. LATEST_MESSAGES is unbounded in time — its
 *  bound is the message count, applied by the caller. */
function resolveWindow(
  kind: "LATEST_MESSAGES" | "LAST_24_HOURS" | "LAST_7_DAYS" | "CUSTOM",
  start: Date | null,
  end: Date | null,
): { start: Date; end: Date | null } {
  const now = new Date();
  switch (kind) {
    case "LAST_24_HOURS":
      return { start: new Date(now.getTime() - 24 * 60 * 60_000), end: null };
    case "LAST_7_DAYS":
      return { start: new Date(now.getTime() - 7 * 24 * 60 * 60_000), end: null };
    case "CUSTOM":
      return { start: start ?? new Date(now.getTime() - 7 * 24 * 60 * 60_000), end };
    case "LATEST_MESSAGES":
    default:
      return { start: new Date(0), end: null };
  }
}
