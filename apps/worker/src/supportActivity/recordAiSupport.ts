import { prisma } from "@support-automation/db";
import { getSupportActivitySettings } from "./settings.js";

/**
 * Records one SupportActivity for a conversation the AI handled on its own, so AI-delivered
 * support shows up in the same reports as the team's — a group that got answered is a group that
 * got supported, whoever did the answering.
 *
 * Three deliberate choices:
 *
 * - **Keyed on the customer's message, not the AI's reply.** The reply leaves as an
 *   OutboundMessage and only becomes a `Message` row later, when WhatsApp echoes it back; keying
 *   on the incoming message means this can be written immediately and reuses
 *   `SupportActivity.messageId @unique` as the idempotency guard, exactly as the human detector
 *   does. A customer message can never collide with a team member's own row, because the AI
 *   fallback only ever runs on non-team-member messages.
 *
 * - **No SupportRule attached.** AI support is not the product of a rule someone configured;
 *   inventing a synthetic rule row to satisfy the column would put a rule in the reports that
 *   nobody wrote. `ruleId` is nullable for exactly this kind of case.
 *
 * - **Never opens or closes a SupportSession.** A session models a person handling a conversation
 *   over time, with a duration that feeds "hours worked". An AI answer has no such span, and
 *   opening a session no human will ever close would leave every AI reply showing as a stale
 *   unresolved conversation on the Reports page.
 *
 * Gated on the same `SupportActivitySettings.enabled` switch as the human detector: if the team
 * is not tracking support activity, the AI does not start a tracking record for them.
 */
export async function recordAiSupportActivity(input: {
  accountId: string;
  groupId: string | null;
  /** The customer message the AI answered. */
  messageId: string;
  occurredAt: Date;
}): Promise<void> {
  // AI fallback is group-only, but the type allows null — a direct message has no group to
  // credit support to, and SupportActivity.groupId is non-nullable.
  if (!input.groupId) return;

  const settings = await getSupportActivitySettings();
  if (!settings.enabled) return;

  try {
    await prisma.supportActivity.create({
      data: {
        accountId: input.accountId,
        groupId: input.groupId,
        actor: "AI",
        teamMemberId: null,
        ruleId: null,
        keywordId: null,
        messageId: input.messageId,
        occurredAt: input.occurredAt,
      },
    });
  } catch (err) {
    // P2002 means this message already has an activity row — a redelivery, or a human detector
    // row that got there first. Either way the support is already counted once, which is the
    // whole point of the constraint.
    if ((err as { code?: string }).code !== "P2002") throw err;
  }
}
