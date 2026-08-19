import { prisma } from "@support-automation/db";
import { TeamsGraphClient, type TeamsGraphMessage } from "@support-automation/teams-client";
import type { TeamsMessage } from "@prisma/client";
import { getValidTeamsAccessToken } from "./tokenRefresh.js";
import { evaluateResolutionForMessage } from "./resolutionEngine.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";

async function upsertMessage(channelId: string, parentMessageId: string | null, msg: TeamsGraphMessage): Promise<{ row: TeamsMessage; wasNew: boolean }> {
  try {
    const row = await prisma.teamsMessage.create({
      data: {
        channelId,
        externalMessageId: msg.id,
        senderExternalId: msg.from?.userId ?? "unknown",
        senderDisplayName: msg.from?.displayName ?? null,
        body: msg.body,
        parentMessageId,
        sentAt: new Date(msg.createdDateTime),
      },
    });
    return { row, wasNew: true };
  } catch (err: any) {
    if (err?.code === "P2002") {
      const row = await prisma.teamsMessage.findUniqueOrThrow({
        where: { channelId_externalMessageId: { channelId, externalMessageId: msg.id } },
      });
      return { row, wasNew: false };
    }
    throw err;
  }
}

export interface TeamsSyncResult {
  ran: boolean;
  teamsSeen: number;
  channelsSeen: number;
  messagesStored: number;
}

/**
 * Pure decision: should this channel's messages be pulled this sync tick? An Issue explicitly
 * linked to the channel always wins (an admin deliberately connected this exact conversation —
 * disabling the coarser team/channel toggle must never silently break an existing link). Otherwise
 * both the parent team AND the channel itself must be enabled for automation — see the schema doc
 * comments on TeamsTeam/TeamsChannel.isEnabledForAutomation for why both levels exist. Exported and
 * tested independently of the network-calling sync loop it's used in (see automationScope.test.ts).
 */
export function isChannelInAutomationScope(
  team: { isEnabledForAutomation: boolean },
  channel: { isEnabledForAutomation: boolean },
  hasLinkedIssue: boolean,
): boolean {
  if (hasLinkedIssue) return true;
  return team.isEnabledForAutomation && channel.isEnabledForAutomation;
}

/**
 * One sync pass: refresh the access token if needed, list every joined team/channel (always —
 * cheap, no message bodies, and it's what powers the Manage Teams/Channels selection UI), and pull
 * new messages + replies only for a channel that's either enabled for automation (both its parent
 * TeamsTeam and the channel itself — see schema doc comments) or explicitly linked to an open
 * SupportIssue (an Issue link always wins over the coarser enabled/disabled toggle). Sets
 * TeamsAccount.status to SYNCING for the duration so the UI can show "Synchronizing…" distinctly
 * from steady-state CONNECTED, without fabricating a progress percentage (Graph's list endpoints
 * don't expose a reliable total up front). Returns { ran: false } (never throws) when Teams isn't
 * configured/connected/needs-reauth — same no-op-when-unconfigured convention as every other
 * optional feature in this app.
 */
export async function runTeamsSync(): Promise<TeamsSyncResult> {
  const accessToken = await getValidTeamsAccessToken();
  if (!accessToken) return { ran: false, teamsSeen: 0, channelsSeen: 0, messagesStored: 0 };

  await prisma.teamsAccount.update({ where: { id: "global" }, data: { status: "SYNCING" } });
  await logSystemEvent("INFO", "teams", "TEAMS_SYNC_STARTED", {});

  const graph = new TeamsGraphClient(accessToken);
  let teamsSeen = 0;
  let channelsSeen = 0;
  let messagesStored = 0;

  try {
    const teams = await graph.listJoinedTeams();
    for (const team of teams) {
      const teamRow = await prisma.teamsTeam.upsert({
        where: { externalTeamId: team.id },
        update: { name: team.displayName },
        create: { externalTeamId: team.id, name: team.displayName },
      });
      teamsSeen += 1;

      const channels = await graph.listChannels(team.id);
      for (const channel of channels) {
        const channelRow = await prisma.teamsChannel.upsert({
          where: { teamId_externalChannelId: { teamId: teamRow.id, externalChannelId: channel.id } },
          update: { name: channel.displayName, channelType: channel.membershipType },
          create: {
            teamId: teamRow.id,
            externalChannelId: channel.id,
            name: channel.displayName,
            channelType: channel.membershipType,
          },
        });
        channelsSeen += 1;

        const hasLinkedIssue = await prisma.supportIssue.findFirst({
          where: { teamsChannelId: channelRow.id, status: { notIn: ["RESOLVED", "CLOSED"] } },
          select: { id: true },
        });
        if (!isChannelInAutomationScope(teamRow, channelRow, Boolean(hasLinkedIssue))) continue;

        const rootMessages = await graph.listChannelMessages(team.id, channel.id);
        for (const rootMessage of rootMessages) {
          const rootResult = await upsertMessage(channelRow.id, null, rootMessage);
          if (rootResult.wasNew) {
            messagesStored += 1;
            await evaluateResolutionForMessage(rootResult.row);
          }

          const replies = await graph.listMessageReplies(team.id, channel.id, rootMessage.id);
          for (const reply of replies) {
            const replyResult = await upsertMessage(channelRow.id, rootResult.row.id, reply);
            if (replyResult.wasNew) {
              messagesStored += 1;
              await evaluateResolutionForMessage(replyResult.row);
            }
          }
        }
      }
    }

    await prisma.teamsAccount.update({
      where: { id: "global" },
      data: { lastSyncAt: new Date(), lastSyncError: null, status: "CONNECTED" },
    });
    await logSystemEvent("INFO", "teams", "TEAMS_SYNC_COMPLETED", { teamsSeen, channelsSeen, messagesStored });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    await prisma.teamsAccount.update({ where: { id: "global" }, data: { status: "ERROR", lastSyncError: message } }).catch(() => {});
    await logSystemEvent("ERROR", "teams", "TEAMS_SYNC_FAILED", { error: message });
  }

  return { ran: true, teamsSeen, channelsSeen, messagesStored };
}
