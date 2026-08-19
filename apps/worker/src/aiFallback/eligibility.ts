import type { AutomationMode } from "@prisma/client";

export interface AiFallbackEligibilityContext {
  automationEnabled: boolean;
  mode: AutomationMode;
  /** Null for a direct message — AI fallback is per-group opt-in only, so a DM is always ineligible. */
  group: { isMonitored: boolean; aiAutomationEnabled: boolean; aiSuppressedUntil: Date | null } | null;
  aiEngineEnabled: boolean;
  autoResponseEnabled: boolean;
  /** Real wall-clock time, passed explicitly to keep this function pure/testable — never a
   * message-derived timestamp, which could be backdated on a replayed/retried event. */
  now: Date;
}

export type AiFallbackEligibility = { eligible: true } | { eligible: false; reason: string };

/**
 * The Hybrid AI Automation fallback layer's opt-in gate. Deliberately checked BEFORE anything is
 * persisted or any AI call is made: every one of these defaults to "off"/false, so an ineligible
 * message must produce zero side effects — no AiFallbackDecision row, no notification — identical
 * to today's behavior for a group/account that never opted in. Only a message that clears every
 * gate here but then hits a real failure (AI unavailable, low confidence, malformed response, a
 * safety-gate rejection) becomes a persisted, notification-worthy HUMAN_FALLBACK outcome — see
 * runAiFallback.ts. Getting this backwards would turn every NO_MATCH message on every group into
 * an "AI Assistance Required" alert the moment this feature ships, which is exactly the volume/
 * behavior change this gate exists to prevent.
 */
export function checkAiFallbackEligibility(ctx: AiFallbackEligibilityContext): AiFallbackEligibility {
  if (!ctx.automationEnabled) {
    return { eligible: false, reason: "Automation is globally paused (kill switch)." };
  }
  if (ctx.mode === "MANUAL_ONLY") {
    return { eligible: false, reason: "Automation mode is MANUAL_ONLY; AI fallback never runs." };
  }
  if (!ctx.group) {
    return { eligible: false, reason: "Message has no monitored group (AI fallback is per-group opt-in only)." };
  }
  if (!ctx.group.isMonitored) {
    return { eligible: false, reason: "The message's group is not a monitored conversation." };
  }
  if (!ctx.group.aiAutomationEnabled) {
    return { eligible: false, reason: "AI Automation is not enabled for this group." };
  }
  if (ctx.group.aiSuppressedUntil && ctx.group.aiSuppressedUntil > ctx.now) {
    // Human takeover: a team member is actively handling this group right now — silent, same
    // zero-side-effect philosophy as every other gate. Deterministic rules/escalation are
    // completely unaffected; only the AI fallback stage is paused, and only for this one group.
    return { eligible: false, reason: `A team member is actively handling this group until ${ctx.group.aiSuppressedUntil.toISOString()}.` };
  }
  if (!ctx.aiEngineEnabled) {
    return { eligible: false, reason: "AI Engine is disabled in AI Settings." };
  }
  if (!ctx.autoResponseEnabled) {
    return { eligible: false, reason: "AI auto-response is disabled in AI Settings." };
  }
  return { eligible: true };
}
