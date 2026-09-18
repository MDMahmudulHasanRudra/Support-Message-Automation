import { prisma } from "@support-automation/db";
import { resolveAiClient, type AiClient } from "@support-automation/ai-client";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import {
  MAX_REPLIES_PER_BUILD,
  MIN_REPLIES_FOR_A_PROFILE,
  buildStyleProfilePrompt,
  parseStyleGuidance,
} from "./communicationStylePrompt.js";
import { getAiSettings } from "../ai/settings.js";

/**
 * Builds the team's communication-style profile from the replies its executives actually sent.
 *
 * Read-only with respect to WhatsApp: it never sends, never queues, never writes a knowledge entry
 * and never creates a rule. Its single output is one row of prose that a person must approve
 * before it affects anything.
 *
 * Off by default (`AiSettings.communicationStyleLearningEnabled`), and every rebuild clears the
 * approval — so new guidance never inherits the trust granted to the guidance it replaced.
 */

export interface StyleBuildResult {
  ran: boolean;
  skipped?: string;
  repliesAnalyzed?: number;
  guidanceChanged?: boolean;
}

export async function getStyleProfile() {
  return prisma.communicationStyleProfile.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
}

/**
 * The messages that count as "how this team writes".
 *
 * Two sources, because neither is sufficient on its own:
 *
 *  - **Outgoing messages this system did not send.** An executive replying from the business phone
 *    produces an outgoing message with no matching OutboundMessage row. This is the bulk of the
 *    real material — on the live database, 336 of 361 outgoing messages.
 *  - **Incoming messages from a known team member**, for staff replying from their own number.
 *
 * Excluded, deliberately:
 *
 *  - Anything this system sent itself. Learning style from the AI's own output would tighten a
 *    loop around whatever voice it started with, and drift would compound with every rebuild.
 *  - The internal notification groups. What gets posted there is machine-written alerts
 *    ("UNKNOWN PATTERN DETECTED"), which is not how anyone talks to a customer.
 */
async function collectSupportReplies(builtThroughAt: Date | null) {
  const [automationSettings, aiSettings] = await Promise.all([
    prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
    getAiSettings(),
  ]);

  const notifyGroupIds = [
    ...(automationSettings.whatsappNotificationGroupIds ?? []),
    ...(aiSettings.takeoverNotifyGroupIds ?? []),
  ];
  const excludedGroups = notifyGroupIds.length
    ? await prisma.whatsAppGroup.findMany({
        where: { whatsappGroupId: { in: notifyGroupIds } },
        select: { id: true },
      })
    : [];
  const excludedGroupIds = excludedGroups.map((group) => group.id);

  // What this system sent itself, identified the way the chat inbox already does it: an
  // OutboundMessage's providerMessageId is the WhatsApp id of the echo that comes back. There is
  // no Prisma relation between the two — the link is id equality — so the ids are fetched and
  // excluded explicitly. Scoped to the window being read, so this stays small as sends accumulate.
  const ourSends = await prisma.outboundMessage.findMany({
    where: {
      providerMessageId: { not: null },
      ...(builtThroughAt ? { sentAt: { gte: builtThroughAt } } : {}),
    },
    select: { providerMessageId: true },
  });
  const ourMessageIds = ourSends
    .map((row) => row.providerMessageId)
    .filter((id): id is string => Boolean(id));

  return prisma.message.findMany({
    where: {
      ...(builtThroughAt ? { timestampWa: { gt: builtThroughAt } } : {}),
      ...(ourMessageIds.length ? { whatsappMessageId: { notIn: ourMessageIds } } : {}),
      // NOT IN never matches NULL — SQL's three-valued logic, which Prisma's `notIn` inherits. A
      // bare `groupId: { notIn: [...] }` therefore discarded every message whose group was never
      // resolved, which on the live database was 319 of 361 outgoing messages: the profile was
      // built from 2 replies instead of ~336. The null case has to be spelled out.
      ...(excludedGroupIds.length
        ? { OR: [{ groupId: null }, { groupId: { notIn: excludedGroupIds } }] }
        : {}),
      AND: [
        {
          OR: [
            { direction: "OUTGOING" },
            { direction: "INCOMING", isFromTeamMember: true },
          ],
        },
      ],
    },
    orderBy: { timestampWa: "desc" },
    take: MAX_REPLIES_PER_BUILD,
    select: { body: true, timestampWa: true },
  });
}

/**
 * Removes anything that identifies a person before a reply is shown to the model.
 *
 * The same reasoning as the group knowledge builder's role reduction: the model cannot copy a
 * customer's number into the guidance if it never saw one. Applied here even though the output is
 * supposed to be about manner, because "supposed to" is not a guarantee.
 */
export function redactReply(body: string): string {
  return body
    // The leading + is part of the number and must go with it, or "+880 1896-218186" redacts to
    // "+[number]" — which still says which country the customer is in.
    .replace(/\+?\b\d[\d\s().-]{7,}\d\b/g, "[number]")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "[email]")
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/@\d+/g, "[mention]")
    .trim();
}

/** Machine-written alerts this system posts to its own groups — never a model for human writing. */
function isSystemNotification(body: string): boolean {
  return /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]*[A-Z][A-Z\s&]{6,}$/mu.test(body.split("\n")[0] ?? "");
}

/** `clientOverride` is the test-only seam every AI job in this worker uses. */
export async function buildCommunicationStyleProfile(clientOverride?: AiClient): Promise<StyleBuildResult> {
  const aiSettings = await getAiSettings();
  if (!aiSettings.aiEngineEnabled) return { ran: false, skipped: "AI_ENGINE_DISABLED" };
  if (!aiSettings.communicationStyleLearningEnabled) return { ran: false, skipped: "STYLE_LEARNING_DISABLED" };

  const profile = await getStyleProfile();
  const messages = await collectSupportReplies(profile.builtThroughAt);

  const replies = messages
    .map((message) => redactReply(message.body))
    .filter((body) => body.length >= 15 && !isSystemNotification(body));

  if (replies.length < MIN_REPLIES_FOR_A_PROFILE) {
    // Two very different situations reach here, and reporting them the same way was wrong.
    //
    // collectSupportReplies only returns replies written SINCE the last build, so once a profile
    // exists the steady state is zero new ones — that is the feature working, not failing. It was
    // recorded as an error regardless, which put "Only 0 support replies available — 25 are needed
    // before a style can be described" on a page that was simultaneously showing a described style,
    // in use, built from 62 replies. Read literally it says the feature cannot work, while it is
    // working.
    const hasProfile = Boolean(profile.guidance?.trim());
    await prisma.communicationStyleProfile.update({
      where: { id: "global" },
      data: {
        lastBuiltAt: new Date(),
        // Clearing it matters as much as not setting it: a genuine shortage recorded before the
        // first successful build must not stay on screen forever afterwards.
        lastError: hasProfile
          ? null
          : `Only ${replies.length} support replies available — ${MIN_REPLIES_FOR_A_PROFILE} are needed before a style can be described.`,
      },
    });
    return {
      ran: false,
      skipped: hasProfile ? "NOTHING_NEW_TO_LEARN_FROM" : "NOT_ENOUGH_REPLIES",
      repliesAnalyzed: replies.length,
    };
  }

  const ai = clientOverride ?? (await resolveAiClient("LEARNING"));
  if (!ai) return { ran: false, skipped: "AI_UNAVAILABLE" };

  const prompt = buildStyleProfilePrompt({
    // Oldest-first reads more like a conversation than the newest-first query order.
    replies: [...replies].reverse(),
    defaultReplyLanguage: aiSettings.defaultReplyLanguage,
  });

  try {
    const completion = await ai.complete({
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      maxTokens: prompt.maxTokens,
      temperature: prompt.temperature,
    });

    const guidance = parseStyleGuidance(completion.text ?? "");
    const newest = messages[0]?.timestampWa ?? new Date();

    if (!guidance) {
      await prisma.communicationStyleProfile.update({
        where: { id: "global" },
        data: {
          lastBuiltAt: new Date(),
          builtThroughAt: newest,
          lastError: "The replies did not show a consistent enough style to describe.",
        },
      });
      return { ran: true, skipped: "NO_CLEAR_STYLE", repliesAnalyzed: replies.length };
    }

    const changed = guidance !== profile.guidance;
    await prisma.communicationStyleProfile.update({
      where: { id: "global" },
      data: {
        guidance,
        messagesAnalyzed: replies.length,
        builtThroughAt: newest,
        lastBuiltAt: new Date(),
        lastError: null,
        // New guidance never inherits the old approval. Style shapes every answer, so a rebuild
        // that quietly kept its predecessor's trust would put unreviewed instructions in front of
        // customers without anyone choosing to.
        ...(changed ? { humanApproved: false, approvedAt: null, approvedById: null } : {}),
      },
    });

    await logSystemEvent("INFO", "style", "Rebuilt the communication style profile", {
      repliesAnalyzed: replies.length,
      changed,
    });
    return { ran: true, repliesAnalyzed: replies.length, guidanceChanged: changed };
  } catch (err) {
    await prisma.communicationStyleProfile.update({
      where: { id: "global" },
      data: { lastBuiltAt: new Date(), lastError: "The AI provider could not be reached while building the profile." },
    });
    await logSystemEvent("ERROR", "style", "Communication style build failed", { error: (err as Error).message });
    return { ran: true, skipped: "AI_ERROR" };
  }
}

/**
 * The guidance to put in a reply prompt, or null.
 *
 * Null whenever learning is off, nothing has been built, or nobody has approved what was built —
 * the three states in which the assistant should simply write the way it always did.
 */
export async function getApprovedStyleGuidance(): Promise<string | null> {
  const profile = await prisma.communicationStyleProfile.findUnique({ where: { id: "global" } });
  if (!profile?.humanApproved) return null;
  return profile.guidance?.trim() || null;
}
