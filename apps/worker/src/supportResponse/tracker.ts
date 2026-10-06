import { applyResponseMessage, classifyResponseMessage } from "@support-automation/shared";
import type { EpisodeAction, ResponseMessageRole } from "@support-automation/shared";
import { prisma } from "../db.js";
import { resolveActiveTeamMember } from "../pipeline/teamFilter.js";

/** What `trackSupportResponse` decided for one message. */
export interface SupportResponseTrack {
  role: ResponseMessageRole;
  /** The roster member who sent the message, whatever their Team. */
  memberId: string | null;
  action: EpisodeAction["kind"];
  /** The episode the message opened, extended or answered. */
  episodeId: string | null;
}

/**
 * Support response tracking (SUPPORT_RESPONSE.md): keeps each group's `SupportResponseEpisode` in
 * step with the messages arriving in it, so Messages → Unanswered Groups and Response Time are read
 * straight from rows rather than recomputed from message history on every page load.
 *
 * Called by the pipeline right after a NEW incoming message is stored — live or recovered after a
 * gap, which is why it decides by the message's own timestamp rather than its arrival order. It
 * never runs twice for one message: the `Message` insert it follows is the pipeline's dedup guard.
 *
 * Never throws, and never gates the pipeline: a tracking failure is logged and the message carries
 * on through rules, AI and escalation exactly as before.
 *
 * Who counts as Support is read at the moment of the message — the member's Team then, from
 * `TeamMembership` — so moving somebody to another Team later never rewrites a response already
 * recorded, and their replies from before the move still count.
 *
 * Returns what it did (null when it did not run, or failed), so Support Assignment
 * (SUPPORT_ASSIGNMENT.md), which is built on these episodes, reads the same decision rather than
 * making a second one.
 */
export async function trackSupportResponse(input: {
  messageId: string;
  groupId: string | null;
  accountId: string;
  direction: "INCOMING" | "OUTGOING" | "SYSTEM";
  senderPhone: string;
  timestampWa: Date;
}): Promise<SupportResponseTrack | null> {
  try {
    if (!input.groupId) return null; // groups only: a 1:1 chat is not a support group
    const settings = await prisma.supportActivitySettings.findUnique({ where: { id: "global" }, select: { responseTrackingTeamIds: true } });
    const supportTeamIds = settings?.responseTrackingTeamIds ?? [];
    if (supportTeamIds.length === 0) return null; // not set up: nothing is tracked until a Support Team is chosen

    const at = input.timestampWa;
    let memberId: string | null = null;
    let supportTeamId: string | null = null;
    if (input.direction === "INCOMING") {
      const member = await resolveActiveTeamMember(input.senderPhone);
      if (member) {
        memberId = member.id;
        const membership = await prisma.teamMembership.findFirst({
          where: {
            teamMemberId: member.id,
            teamId: { in: supportTeamIds },
            AND: [{ OR: [{ startedAt: null }, { startedAt: { lte: at } }] }, { OR: [{ endedAt: null }, { endedAt: { gt: at } }] }],
          },
          select: { teamId: true },
        });
        supportTeamId = membership?.teamId ?? null;
      }
    }

    const role = classifyResponseMessage({ direction: input.direction, memberId, inSupportTeam: supportTeamId !== null });
    if (role !== "CUSTOMER" && role !== "SUPPORT") return { role, memberId, action: "NONE", episodeId: null }; // nothing else changes an episode

    const groupId = input.groupId;
    return await prisma.$transaction(async (tx): Promise<SupportResponseTrack> => {
      // One group's messages decided one at a time, so two arriving together cannot both open an
      // episode (the partial unique index would refuse the second anyway) or both answer one.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`support-response:${groupId}`})::bigint)`;
      const open = await tx.supportResponseEpisode.findFirst({ where: { groupId, status: "UNANSWERED" } });

      let closedThroughAt: number | null = null;
      const lastAnswered =
        !open && role === "SUPPORT"
          ? await tx.supportResponseEpisode.findFirst({
              where: { groupId, status: "ANSWERED" },
              orderBy: { supportRepliedAt: "desc" },
              select: { id: true, firstIncomingAt: true, supportRepliedAt: true },
            })
          : null;
      if (!open && role === "CUSTOMER") {
        const [answered, cleared] = await Promise.all([
          tx.supportResponseEpisode.findFirst({ where: { groupId, status: "ANSWERED" }, orderBy: { supportRepliedAt: "desc" }, select: { supportRepliedAt: true } }),
          tx.supportResponseEpisode.findFirst({ where: { groupId, status: "CLEARED" }, orderBy: { latestIncomingAt: "desc" }, select: { latestIncomingAt: true } }),
        ]);
        const bounds = [answered?.supportRepliedAt?.getTime(), cleared?.latestIncomingAt.getTime()].filter((t): t is number => t !== undefined);
        closedThroughAt = bounds.length ? Math.max(...bounds) : null;
      }

      const action = applyResponseMessage({
        role,
        at: at.getTime(),
        open: open ? { firstIncomingAt: open.firstIncomingAt.getTime(), latestIncomingAt: open.latestIncomingAt.getTime() } : null,
        closedThroughAt,
        lastAnswered: lastAnswered?.supportRepliedAt
          ? { firstIncomingAt: lastAnswered.firstIncomingAt.getTime(), supportRepliedAt: lastAnswered.supportRepliedAt.getTime() }
          : null,
      });

      switch (action.kind) {
        case "OPEN": {
          const created = await tx.supportResponseEpisode.create({
            data: {
              accountId: input.accountId,
              groupId,
              firstIncomingMessageId: input.messageId,
              firstIncomingAt: at,
              latestIncomingMessageId: input.messageId,
              latestIncomingAt: at,
              incomingMessageCount: 1,
            },
            select: { id: true },
          });
          return { role, memberId, action: action.kind, episodeId: created.id };
        }
        case "EXTEND":
          await tx.supportResponseEpisode.update({
            where: { id: open!.id },
            data: {
              incomingMessageCount: { increment: 1 },
              ...(action.movesFirst ? { firstIncomingMessageId: input.messageId, firstIncomingAt: at } : {}),
              ...(action.movesLatest ? { latestIncomingMessageId: input.messageId, latestIncomingAt: at } : {}),
            },
          });
          return { role, memberId, action: action.kind, episodeId: open!.id };
        case "ANSWER":
          await tx.supportResponseEpisode.update({
            where: { id: open!.id },
            data: {
              status: "ANSWERED",
              supportReplyMessageId: input.messageId,
              supportRepliedAt: at,
              supportMemberId: memberId,
              supportTeamId,
              responseSeconds: action.responseSeconds,
            },
          });
          return { role, memberId, action: action.kind, episodeId: open!.id };
        case "REANSWER":
          // Two members replied moments apart and the later one was processed first: the earlier
          // reply is the real answer, so the record says so.
          await tx.supportResponseEpisode.update({
            where: { id: lastAnswered!.id },
            data: {
              supportReplyMessageId: input.messageId,
              supportRepliedAt: at,
              supportMemberId: memberId,
              supportTeamId,
              responseSeconds: action.responseSeconds,
            },
          });
          return { role, memberId, action: action.kind, episodeId: lastAnswered!.id };
        default:
          return { role, memberId, action: "NONE", episodeId: null };
      }
    });
  } catch (err) {
    console.error(`[support-response] could not track message ${input.messageId}; the message itself is stored`, err);
    return null;
  }
}
