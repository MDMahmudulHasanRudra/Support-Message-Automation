import type { MoodAlert, MoodAlertAction } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { resolveAiClient, type AiClient } from "@support-automation/ai-client";
import { isResolutionError, resolveWhatsAppAccount } from "@support-automation/db";
import {
  actionsForPolicy,
  applyMoodTrend,
  CONVERSATION_BEHAVIOUR_LABELS,
  decideMoodTrigger,
  describeMoodTrend,
  isMood,
  mergeAiReading,
  MOOD_AI_SYSTEM_PROMPT,
  MOOD_CUSTOMER_MESSAGE_VARIANT,
  MOOD_EMOJI,
  MOOD_LABELS,
  MOOD_LEVEL,
  MOOD_SIGNAL_LABELS,
  isMoodSignal,
  moodCustomerTemplateKey,
  parseMoodAiAnswer,
  strongerBehaviour,
  TRIGGERABLE_MOODS,
  type Mood,
  type MoodAction,
  type MoodPolicy,
  type MoodReading,
  type TriggerableMood,
} from "@support-automation/shared";
import { platformPrisma, prisma } from "../db.js";
import { OPERATING_PROJECT_STATUSES, currentProjectId, withProject } from "../project/context.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { enqueueNotification } from "../notifications/enqueueNotification.js";
import { getEventDelivery, resolveWhatsAppDestinations } from "../notifications/eventSettings.js";
import { renderNotification } from "../notifications/templates.js";
import { getAutomationSettings } from "../pipeline/settings.js";
import { checkAutoReplySafety } from "../pipeline/safety.js";
import { enqueueOutboundMessage } from "../pipeline/enqueueOutbound.js";
import { resolveMentionTargets } from "../aiFallback/mentionTeam.js";
import { getMoodSettings, pauseAiInWhatsAppGroup, pauseUntil, previousMoods, type ResolvedMoodSettings } from "./moodDetection.js";

/**
 * Mood Detection's asynchronous half (MOOD_DETECTION.md).
 *
 * Each tick finishes one recorded reading — optional AI classification of an ambiguous one, trend,
 * threshold, policy, and the alert that is the cooldown unit — and then works through the due
 * actions. Every action is its own row, retried on its own, so a WhatsApp outage delays the team
 * alert without delaying the AI pause, and a failed customer message never re-sends the alert.
 */

const LOOP_NAME = "mood-detection";
/** Attempts per event and per action before it is left FAILED. */
export const MOOD_MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30_000;
const ACTIONS_PER_TICK = 5;
/** Older than this while PROCESSING means whatever claimed it went away. */
export const MOOD_STUCK_AFTER_MS = 5 * 60_000;

// ---------------------------------------------------------------------------------------------
// Claiming

async function claimNextEvent(): Promise<{ id: string; projectId: string } | null> {
  const candidate = await platformPrisma.customerMoodEvent.findFirst({
    where: { status: "PENDING", scheduledAt: { lte: new Date() }, project: { status: { in: [...OPERATING_PROJECT_STATUSES] } } },
    orderBy: { scheduledAt: "asc" },
    select: { id: true, projectId: true },
  });
  if (!candidate) return null;
  const claim = await platformPrisma.customerMoodEvent.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: { status: "PROCESSING", attempts: { increment: 1 } },
  });
  return claim.count === 1 ? candidate : null;
}

async function claimNextAction(): Promise<{ id: string; projectId: string } | null> {
  const candidate = await platformPrisma.moodAlertAction.findFirst({
    where: { status: "PENDING", scheduledAt: { lte: new Date() }, project: { status: { in: [...OPERATING_PROJECT_STATUSES] } } },
    orderBy: { scheduledAt: "asc" },
    select: { id: true, projectId: true },
  });
  if (!candidate) return null;
  const claim = await platformPrisma.moodAlertAction.updateMany({
    where: { id: candidate.id, status: "PENDING" },
    data: { status: "PROCESSING", attempts: { increment: 1 } },
  });
  return claim.count === 1 ? candidate : null;
}

export interface MoodProcessorDeps {
  /** Tests inject a fake model; production resolves the RESPONSE job's client. */
  aiClient?: AiClient | null;
}

/** One reading, if any is due. Returns whether one was worked. */
export async function processNextMoodEvent(deps: MoodProcessorDeps = {}): Promise<boolean> {
  const claimed = await claimNextEvent();
  if (!claimed) return false;
  await withProject(claimed.projectId, async () => {
    try {
      await analyzeMoodEvent(claimed.id, deps);
    } catch (err) {
      await failOrRetryEvent(claimed.id, err);
    }
  });
  return true;
}

/** One action, if any is due. */
export async function processNextMoodAction(): Promise<boolean> {
  const claimed = await claimNextAction();
  if (!claimed) return false;
  await withProject(claimed.projectId, async () => {
    try {
      const outcome = await runMoodAction(claimed.id);
      await prisma.moodAlertAction.update({
        where: { id: claimed.id },
        data: { status: outcome.done ? "DONE" : "SKIPPED", detail: outcome.detail.slice(0, 500), lastError: null, completedAt: new Date() },
      });
    } catch (err) {
      await failOrRetryAction(claimed.id, err);
    }
  });
  return true;
}

async function failOrRetryEvent(id: string, err: unknown): Promise<void> {
  const row = await prisma.customerMoodEvent.findUnique({ where: { id }, select: { attempts: true } });
  const exhausted = (row?.attempts ?? MOOD_MAX_ATTEMPTS) >= MOOD_MAX_ATTEMPTS;
  await prisma.customerMoodEvent.update({
    where: { id },
    data: exhausted
      ? { status: "FAILED", lastError: errorText(err) }
      : { status: "PENDING", lastError: errorText(err), scheduledAt: new Date(Date.now() + RETRY_DELAY_MS * (row?.attempts ?? 1)) },
  });
  if (exhausted) await logSystemEvent("ERROR", "mood-detection", "A mood reading could not be analysed", { eventId: id, error: errorText(err) });
}

async function failOrRetryAction(id: string, err: unknown): Promise<void> {
  const row = await prisma.moodAlertAction.findUnique({ where: { id }, select: { attempts: true, action: true, alertId: true } });
  const exhausted = (row?.attempts ?? MOOD_MAX_ATTEMPTS) >= MOOD_MAX_ATTEMPTS;
  await prisma.moodAlertAction.update({
    where: { id },
    data: exhausted
      ? { status: "FAILED", lastError: errorText(err), completedAt: new Date() }
      : { status: "PENDING", lastError: errorText(err), scheduledAt: new Date(Date.now() + RETRY_DELAY_MS * (row?.attempts ?? 1)) },
  });
  if (exhausted) {
    await logSystemEvent("ERROR", "mood-detection", "A Mood Detection action failed after every retry", {
      actionId: id,
      action: row?.action,
      alertId: row?.alertId,
      error: errorText(err),
    });
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

// ---------------------------------------------------------------------------------------------
// Analysis

/** Finishes one reading. Exported for tests; production reaches it through the claim above. */
export async function analyzeMoodEvent(eventId: string, deps: MoodProcessorDeps = {}): Promise<void> {
  const event = await prisma.customerMoodEvent.findUniqueOrThrow({ where: { id: eventId } });
  const settings = await getMoodSettings();
  const now = new Date();

  if (!settings.enabled) {
    await prisma.customerMoodEvent.update({
      where: { id: eventId },
      data: { status: "ANALYZED", analyzedAt: now, triggered: false, decisionNote: "Mood Detection was switched off before this message was analysed." },
    });
    return;
  }
  if (!isMood(event.mood)) throw new Error(`Unknown stored mood "${event.mood}".`);

  let reading: MoodReading = {
    mood: event.mood,
    confidence: event.confidence,
    scores: (event.scores ?? {}) as MoodReading["scores"],
    signals: event.signals.filter(isMoodSignal),
    needsAi: event.aiRequested,
  };
  let aiUsed = false;
  const notes: string[] = [];

  if (event.aiRequested && settings.useAi) {
    const outcome = await classifyWithAi(event, deps);
    if (outcome.reading) {
      reading = mergeAiReading(reading, outcome.reading);
      aiUsed = true;
      // The trend was applied to the deterministic reading; the AI's needs it too.
      const previous = await previousMoods(event.whatsappGroupId, event.customerKey, event.messageAt, event.id);
      reading = applyMoodTrend(reading, previous, event.messageAt.getTime()).reading;
    } else {
      notes.push(outcome.note);
    }
  }

  const decision = decideMoodTrigger(reading, settings.policies, settings.threshold);
  notes.unshift(decision.because);

  await prisma.customerMoodEvent.update({
    where: { id: eventId },
    data: {
      mood: reading.mood,
      confidence: reading.confidence,
      scores: reading.scores as Prisma.InputJsonValue,
      signals: reading.signals,
      level: MOOD_LEVEL[reading.mood],
      aiUsed,
      triggered: decision.triggered,
      decisionNote: notes.join(" ").slice(0, 500),
      status: "ANALYZED",
      analyzedAt: now,
      lastError: null,
    },
  });

  if (decision.triggered && decision.policy) {
    await attachToAlert({ ...event, mood: reading.mood }, reading, decision.policy, settings, now);
  }
}

async function classifyWithAi(
  event: { id: string; groupId: string; customerKey: string; messageAt: Date },
  deps: MoodProcessorDeps,
): Promise<{ reading: { mood: Mood; confidence: number; signals: MoodReading["signals"] } | null; note: string }> {
  try {
    const client = deps.aiClient !== undefined ? deps.aiClient : await resolveAiClient("RESPONSE", prisma);
    if (!client) return { reading: null, note: "AI classification was wanted but no AI model is available; the rule-based reading stands." };
    // The conversation leading up to the message, reduced to roles: no names and no numbers reach
    // the model.
    const rows = await prisma.message.findMany({
      where: { groupId: event.groupId, timestampWa: { lte: event.messageAt } },
      orderBy: { timestampWa: "desc" },
      take: 10,
      select: { body: true, senderPhone: true, direction: true, isFromTeamMember: true },
    });
    const transcript = rows
      .reverse()
      .map((m) => {
        const role = m.direction === "OUTGOING" || m.isFromTeamMember ? "SUPPORT" : m.senderPhone === event.customerKey ? "CUSTOMER" : "OTHER";
        return `[${role}] ${m.body.replace(/\s+/g, " ").slice(0, 300)}`;
      })
      .join("\n");
    const result = await client.complete({
      systemPrompt: MOOD_AI_SYSTEM_PROMPT,
      userPrompt: `Conversation (oldest first; the last [CUSTOMER] line is the message to classify):\n${transcript}`,
      maxTokens: 80,
      temperature: 0,
    });
    const parsed = parseMoodAiAnswer(result.text);
    if (!parsed) return { reading: null, note: "The AI answer could not be read; the rule-based reading stands." };
    return { reading: parsed, note: "" };
  } catch (err) {
    return { reading: null, note: `AI classification failed (${errorText(err)}); the rule-based reading stands.` };
  }
}

/**
 * Exactly one alert per escalation. Under an advisory lock on (project, WhatsApp group, customer):
 * - no alert inside the cooldown → a new alert with every action this mood's policy switches on;
 * - an open alert at the same or a higher level → this reading is attached to it, nothing re-sent;
 * - an open alert at a LOWER level → it escalates: the alert takes the new mood and priority, the
 *   cooldown restarts, and the new policy's actions run again at the new level — except the message
 *   to the customer, which is sent at most once per alert.
 */
async function attachToAlert(
  event: { id: string; messageId: string; accountId: string; groupId: string; whatsappGroupId: string; customerKey: string; mood: string },
  reading: MoodReading,
  policy: MoodPolicy,
  settings: ResolvedMoodSettings,
  now: Date,
): Promise<void> {
  const cooldownUntil = new Date(now.getTime() + settings.cooldownMinutes * 60_000);
  const level = MOOD_LEVEL[reading.mood];
  const lockKey = `mood:${currentProjectId()}:${event.whatsappGroupId}:${event.customerKey}`;

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
    const open = await tx.moodAlert.findFirst({
      where: { whatsappGroupId: event.whatsappGroupId, customerKey: event.customerKey, cooldownUntil: { gt: now } },
      orderBy: { openedAt: "desc" },
      include: { actions: { select: { id: true, action: true } } },
    });

    if (!open) {
      const alert = await tx.moodAlert.create({
        data: {
          accountId: event.accountId,
          groupId: event.groupId,
          whatsappGroupId: event.whatsappGroupId,
          customerKey: event.customerKey,
          mood: reading.mood,
          level,
          priority: policy.priority,
          confidence: reading.confidence,
          signals: reading.signals,
          firstMessageId: event.messageId,
          latestMessageId: event.messageId,
          openedAt: now,
          cooldownUntil,
        },
      });
      const actions = actionsForPolicy(policy);
      if (actions.length > 0) {
        await tx.moodAlertAction.createMany({ data: actions.map((action) => ({ alertId: alert.id, action, scheduledAt: now })) });
      }
      await tx.customerMoodEvent.update({ where: { id: event.id }, data: { alertId: alert.id } });
      return;
    }

    if (level <= open.level) {
      await tx.moodAlert.update({ where: { id: open.id }, data: { triggerCount: { increment: 1 }, latestMessageId: event.messageId } });
      await tx.customerMoodEvent.update({
        where: { id: event.id },
        data: { alertId: open.id, decisionNote: `Inside the cooldown of an open ${MOOD_LABELS[open.mood as Mood] ?? open.mood} alert — attached to it, nothing sent again.` },
      });
      return;
    }

    // Escalation inside the cooldown.
    const previousPolicy = (TRIGGERABLE_MOODS as readonly string[]).includes(open.mood) ? settings.policies[open.mood as TriggerableMood] : null;
    await tx.moodAlert.update({
      where: { id: open.id },
      data: {
        mood: reading.mood,
        level,
        priority: policy.priority,
        confidence: reading.confidence,
        signals: reading.signals,
        latestMessageId: event.messageId,
        triggerCount: { increment: 1 },
        cooldownUntil,
      },
    });
    const existing = new Map(open.actions.map((a) => [a.action, a.id]));
    for (const action of actionsForPolicy(policy)) {
      const existingId = existing.get(action);
      if (!existingId) {
        await tx.moodAlertAction.create({ data: { alertId: open.id, action, scheduledAt: now } });
        continue;
      }
      if (action === "CUSTOMER_MESSAGE") continue; // once per alert
      if (action === "CONVERSATION" && previousPolicy && !strongerBehaviour(policy.conversation, previousPolicy.conversation)) continue;
      await tx.moodAlertAction.update({
        where: { id: existingId },
        data: { status: "PENDING", attempts: 0, scheduledAt: now, lastError: null, completedAt: null },
      });
    }
    await tx.customerMoodEvent.update({ where: { id: event.id }, data: { alertId: open.id } });
  });
}

// ---------------------------------------------------------------------------------------------
// Actions

interface ActionOutcome {
  done: boolean;
  detail: string;
}

type AlertWithContext = MoodAlert & {
  group: { id: string; name: string; testModeEnabled: boolean; assignedTeamMember: { name: string; status: string } | null };
};

/** Runs one action. Throws to retry; returns SKIPPED with the reason when it deliberately does nothing. */
export async function runMoodAction(actionId: string): Promise<ActionOutcome> {
  const row = await prisma.moodAlertAction.findUniqueOrThrow({ where: { id: actionId } });
  const alert = (await prisma.moodAlert.findUniqueOrThrow({
    where: { id: row.alertId },
    include: { group: { select: { id: true, name: true, testModeEnabled: true, assignedTeamMember: { select: { name: true, status: true } } } } },
  })) as AlertWithContext;
  const settings = await getMoodSettings();
  if (!settings.enabled) return { done: false, detail: "Mood Detection was switched off before this ran." };
  if (!(TRIGGERABLE_MOODS as readonly string[]).includes(alert.mood)) return { done: false, detail: `${alert.mood} has no policy.` };
  const policy = settings.policies[alert.mood as TriggerableMood];

  switch (row.action as MoodAction) {
    case "CONVERSATION":
      return conversationAction(alert, policy, settings);
    case "NEEDS_ATTENTION":
      return needsAttentionAction(alert);
    case "NOTIFY_TEAM":
      return notifyTeamAction(alert, row, policy);
    case "INTERNAL_ALERT":
      return internalAlertAction(alert, policy, settings);
    case "CUSTOMER_MESSAGE":
      return customerMessageAction(alert, settings);
    default:
      return { done: false, detail: `Unknown action ${row.action}.` };
  }
}

async function conversationAction(alert: MoodAlert, policy: MoodPolicy, settings: ResolvedMoodSettings): Promise<ActionOutcome> {
  const until = pauseUntil(policy.conversation, settings, new Date());
  if (!until) return { done: false, detail: "Automation continues — this mood does not pause AI." };
  const rows = await pauseAiInWhatsAppGroup(alert.whatsappGroupId, until);
  const label = CONVERSATION_BEHAVIOUR_LABELS[policy.conversation];
  return {
    done: true,
    detail: rows > 0 ? `${label}: AI replies held back until ${until.toISOString()}.` : `${label}: AI replies were already held back at least that long.`,
  };
}

async function needsAttentionAction(alert: MoodAlert): Promise<ActionOutcome> {
  // WhatsApp Chat's Waiting list is "a customer message nobody has reviewed since". Clearing the
  // review mark puts the conversation back on it in every account's inbox; the next look clears it.
  const { count } = await prisma.whatsAppGroup.updateMany({ where: { whatsappGroupId: alert.whatsappGroupId }, data: { chatReviewedAt: null } });
  return { done: true, detail: `Returned to WhatsApp Chat's Waiting list (${count} inbox${count === 1 ? "" : "es"}).` };
}

async function alertPayload(alert: AlertWithContext, policy: MoodPolicy, mentionTags = "", mentions: string[] = []): Promise<Record<string, unknown>> {
  const message = await prisma.message.findUnique({ where: { id: alert.latestMessageId }, select: { body: true, senderName: true, senderPhone: true } });
  const history = await prisma.customerMoodEvent.findMany({
    where: { whatsappGroupId: alert.whatsappGroupId, customerKey: alert.customerKey, status: "ANALYZED", messageAt: { lte: new Date() } },
    orderBy: { messageAt: "desc" },
    take: 5,
    select: { mood: true },
  });
  const moods = history.reverse().map((h) => h.mood).filter(isMood);
  const mood = alert.mood as Mood;
  const assigned = alert.group.assignedTeamMember?.status === "ACTIVE" ? alert.group.assignedTeamMember.name : "";
  return {
    alertKind: "MOOD_ALERT",
    moodAlertId: alert.id,
    moodLabel: `${MOOD_EMOJI[mood] ?? ""} ${MOOD_LABELS[mood] ?? alert.mood}`.trim(),
    priority: alert.priority,
    confidence: `${Math.round(alert.confidence * 100)}%`,
    groupName: alert.group.name,
    clientName: message?.senderName ?? null,
    clientPhone: message?.senderPhone ?? alert.customerKey,
    message: message?.body ?? "",
    reasons: alert.signals.filter(isMoodSignal).map((s) => MOOD_SIGNAL_LABELS[s]).join(", "),
    trend: describeMoodTrend(moods.slice(0, -1), mood),
    assignedTo: assigned,
    conversation: CONVERSATION_BEHAVIOUR_LABELS[policy.conversation],
    mentionTags,
    mentions,
  };
}

async function notifyTeamAction(alert: AlertWithContext, row: MoodAlertAction, policy: MoodPolicy): Promise<ActionOutcome> {
  const [delivery, automation] = await Promise.all([getEventDelivery("MOOD_ALERT"), getAutomationSettings()]);
  if (!delivery.enabled) return { done: false, detail: "Mood alerts are muted in Notification Center." };
  const payload = await alertPayload(alert, policy);
  const written: string[] = [];
  const shut: string[] = [];

  const destinations = resolveWhatsAppDestinations(delivery, automation.whatsappNotificationGroupIds);
  if (destinations.length > 0) {
    const resolution = await resolveWhatsAppAccount("NOTIFY_WHATSAPP", prisma);
    if (isResolutionError(resolution)) {
      shut.push(`WhatsApp: ${resolution.error}`);
    } else {
      let first = true;
      for (const destination of destinations) {
        const queued = await enqueueNotification({
          type: "WHATSAPP",
          event: "MOOD_ALERT",
          destination,
          accountId: resolution.accountId,
          relatedMessageId: alert.latestMessageId,
          payload,
          // Personal copies once per alert, not once per destination group.
          skipDirectRecipients: !first || row.attempts > 1,
        });
        first = false;
        if (!queued.suppressed) written.push(destination);
      }
      if (written.length === 0) shut.push("WhatsApp: muted");
    }
  } else {
    shut.push("WhatsApp: no alert group configured");
  }

  if (automation.teamsWebhookUrl) {
    const sent = await enqueueNotification({ type: "TEAMS", event: "MOOD_ALERT", destination: automation.teamsWebhookUrl, relatedMessageId: alert.latestMessageId, payload });
    if (!sent.suppressed) written.push("Teams");
    else shut.push("Teams: muted");
  }

  if (written.length === 0) {
    await logSystemEvent("WARN", "mood-detection", "A mood alert reached no team channel", { alertId: alert.id, channels: shut });
    return { done: false, detail: `No team channel could be told (${shut.join("; ")}).` };
  }
  return { done: true, detail: `Team alert queued to ${written.length} destination${written.length === 1 ? "" : "s"}.` };
}

async function internalAlertAction(alert: AlertWithContext, policy: MoodPolicy, settings: ResolvedMoodSettings): Promise<ActionOutcome> {
  if (settings.internalGroupIds.length === 0) return { done: false, detail: "No internal escalation group is chosen in Mood Detection settings." };
  // The setting names WhatsApp groups (…@g.us), as every alert destination does. Each is posted to
  // through an account that is a member of it and is connected — the Notification Center's own
  // sending account when it is one of them, so alerts keep coming from one number where possible.
  const rows = await prisma.whatsAppGroup.findMany({
    where: { whatsappGroupId: { in: settings.internalGroupIds }, isActive: true, account: { status: "CONNECTED" } },
    select: { whatsappGroupId: true, accountId: true },
  });
  const resolution = await resolveWhatsAppAccount("NOTIFY_WHATSAPP", prisma);
  const preferred = isResolutionError(resolution) ? null : resolution.accountId;
  const groups = new Map<string, string>();
  for (const row of rows) {
    if (!groups.has(row.whatsappGroupId) || row.accountId === preferred) groups.set(row.whatsappGroupId, row.accountId);
  }
  if (groups.size === 0) return { done: false, detail: "No connected number is in the chosen internal escalation group." };

  let mentionTags = "";
  let mentions: string[] = [];
  let mentionNote = "";
  if (policy.mentionMember) {
    const { targets } = await resolveMentionTargets(alert.groupId, { event: "MOOD_ALERT", fallbackToOptedIn: settings.unassignedMention === "OPTED_IN" });
    mentions = targets.map((t) => t.chatId);
    mentionTags = targets.map((t) => `@${t.chatId.split("@")[0]}`).join(" ");
    mentionNote = targets.length > 0 ? `, tagging ${targets.map((t) => t.name).join(", ")}` : ", nobody taggable to mention";
  }
  const payload = await alertPayload(alert, policy, mentionTags, mentions);

  let written = 0;
  for (const [destination, accountId] of groups) {
    const queued = await enqueueNotification({
      type: "WHATSAPP",
      event: "MOOD_ALERT",
      destination,
      accountId,
      relatedMessageId: alert.latestMessageId,
      payload,
      skipDirectRecipients: true,
    });
    if (!queued.suppressed) written += 1;
  }
  if (written === 0) return { done: false, detail: "Mood alerts' WhatsApp channel is muted in Notification Center." };
  return { done: true, detail: `Internal alert queued to ${written} group${written === 1 ? "" : "s"}${mentionNote}.` };
}

async function customerMessageAction(alert: AlertWithContext, settings: ResolvedMoodSettings): Promise<ActionOutcome> {
  const assigned = alert.group.assignedTeamMember?.status === "ACTIVE" ? alert.group.assignedTeamMember.name : null;
  if (settings.skipCustomerMessageWhenUnassigned && !assigned) return { done: false, detail: "Nobody is assigned to this group, and the settings skip the customer message then." };
  const key = moodCustomerTemplateKey(alert.mood as Mood);
  if (!key) return { done: false, detail: `${alert.mood} has no customer message.` };

  // Only the Primary number answers customers (the pipeline's own rule). With a Primary set, the
  // message goes from Primary's copy of this group, or not at all; without one, from the number
  // that received the message.
  const primary = await prisma.whatsAppAccount.findFirst({ where: { isPrimary: true }, select: { id: true } });
  const sendingGroup = primary
    ? await prisma.whatsAppGroup.findFirst({ where: { accountId: primary.id, whatsappGroupId: alert.whatsappGroupId, isActive: true }, select: { id: true, accountId: true, testModeEnabled: true } })
    : { id: alert.groupId, accountId: alert.accountId, testModeEnabled: alert.group.testModeEnabled };
  if (!sendingGroup) return { done: false, detail: "The Primary number is not in this group, so no customer message was sent." };

  const automation = await getAutomationSettings();
  const safety = await checkAutoReplySafety({
    accountId: sendingGroup.accountId,
    toPhone: alert.customerKey,
    groupId: sendingGroup.id,
    rule: null,
    cooldownSeconds: null,
    settings: automation,
  });
  if (!safety.allowed) return { done: false, detail: `Not sent: ${safety.reason}` };

  const body = await renderNotification(key, { groupName: alert.group.name, assignedTo: assigned ?? "" });
  const { queued } = await enqueueOutboundMessage({
    accountId: sendingGroup.accountId,
    chatId: alert.whatsappGroupId,
    toPhone: alert.customerKey,
    body,
    // Keyed on the alert's FIRST message: once per alert, whatever retries or escalations follow.
    incomingMessageId: alert.firstMessageId,
    ruleId: null,
    actionType: "AUTO_REPLY",
    settings: automation,
    testMode: sendingGroup.testModeEnabled,
    idempotencyVariant: MOOD_CUSTOMER_MESSAGE_VARIANT,
  });
  return queued ? { done: true, detail: "Customer message queued." } : { done: false, detail: "Already queued for this alert." };
}

// ---------------------------------------------------------------------------------------------
// Recovery and the loop

/** Rows claimed and never settled go back to PENDING (their attempt stays counted). */
export async function recoverStuckMoodWork(): Promise<number> {
  const before = new Date(Date.now() - MOOD_STUCK_AFTER_MS);
  const [events, actions] = await Promise.all([
    platformPrisma.customerMoodEvent.updateMany({ where: { status: "PROCESSING", updatedAt: { lt: before } }, data: { status: "PENDING", scheduledAt: new Date() } }),
    platformPrisma.moodAlertAction.updateMany({ where: { status: "PROCESSING", updatedAt: { lt: before } }, data: { status: "PENDING", scheduledAt: new Date() } }),
  ]);
  return events.count + actions.count;
}

export function startMoodDetectionProcessor(intervalMs = 3_000): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    (async () => {
      await processNextMoodEvent();
      for (let i = 0; i < ACTIONS_PER_TICK; i += 1) {
        if (!(await processNextMoodAction())) break;
      }
    })()
      .catch((err) => console.error("[mood] unexpected error in the mood processor", err))
      .finally(() => {
        processing = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}
