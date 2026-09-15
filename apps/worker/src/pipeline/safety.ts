import { prisma } from "@support-automation/db";
import type { AutomationSettings } from "@prisma/client";
import { isCooldownActive } from "../queue/cooldown.js";
import { exceedsLimit, getGlobalRateLimitUsage, getPerClientLimitUsage } from "../queue/rateLimiter.js";
import type { EngineRule } from "@support-automation/engine";

export interface SafetyCheckResult {
  allowed: boolean;
  reason: string;
}

/**
 * The outbound safety layer every automatic reply must pass BEFORE being
 * queued (per WHATSAPP ACCOUNT SAFETY AND ANTI-SPAM REQUIREMENTS.md). A
 * second, cheaper re-check runs again at send time in the queue processor
 * to catch limits crossed by messages queued in the same burst.
 */
export async function checkAutoReplySafety(params: {
  accountId: string;
  toPhone: string;
  groupId: string | null;
  /**
   * The matched rule, or null for a rule-less send — currently only the Hybrid AI Automation
   * fallback layer (apps/worker/src/aiFallback/), which has no AutomationRule row at all. A null
   * rule is treated as AUTO_REPLY-equivalent for SAFE_AUTO_REPLY eligibility below: an AI-drafted
   * reply is gated by its own confidence threshold instead of a curated rule type, per the
   * confirmed design in AI_HYBRID_AUTOMATION_ARCHITECTURE_IMPACT_REPORT.md.
   */
  rule: EngineRule | null;
  /** Cooldown lives on the DB row, not the pure EngineRule shape — passed explicitly. */
  cooldownSeconds: number | null;
  settings: AutomationSettings;
}): Promise<SafetyCheckResult> {
  const { accountId, toPhone, groupId, rule, cooldownSeconds, settings } = params;

  if (!settings.automationEnabled) {
    return { allowed: false, reason: "Automation is globally paused (kill switch)." };
  }

  if (settings.mode === "MANUAL_ONLY") {
    return { allowed: false, reason: "Automation mode is MANUAL_ONLY; no automatic replies are sent." };
  }

  // SAFE_AUTO_REPLY allows the two "vetted acknowledgement" rule categories:
  // plain AUTO_REPLY rules and a SUPPORT_ESCALATION rule's own acknowledgement
  // (per the spec's SUPPORT ACKNOWLEDGEMENT SAFETY example — one acknowledgement
  // is sent, the support team is still notified separately). Everything else
  // (EXCEPTION, GENERIC, LAST_SENDER, etc.) requires FULL_RULE_AUTOMATION. A null
  // rule (AI fallback) is treated as AUTO_REPLY for this check.
  if (!toPhone) {
    return { allowed: false, reason: "Destination phone number is missing or invalid." };
  }

  // Read before the rule-type and throttle checks below, because an approved test group relaxes
  // both. The monitored requirement itself is never relaxed — an unmonitored group is not a
  // conversation this system was invited into, which is a different thing from a throttle.
  let testMode = false;
  if (groupId) {
    const group = await prisma.whatsAppGroup.findUnique({
      where: { id: groupId },
      select: { isMonitored: true, testModeEnabled: true },
    });
    if (!group?.isMonitored) {
      return { allowed: false, reason: "The message's group is not a monitored conversation." };
    }
    testMode = group.testModeEnabled;
  }

  const SAFE_MODE_ELIGIBLE_TYPES = new Set(["AUTO_REPLY", "SUPPORT_ESCALATION"]);
  const effectiveRuleType = rule?.type ?? "AUTO_REPLY";
  // Test mode lifts this one deliberately: under SAFE_AUTO_REPLY most rule types can never fire,
  // so there would be no way to exercise them at all. MANUAL_ONLY above is still honoured — that
  // is an operator saying "send nothing", which is a kill switch, not a throttle.
  if (settings.mode === "SAFE_AUTO_REPLY" && !SAFE_MODE_ELIGIBLE_TYPES.has(effectiveRuleType) && !testMode) {
    return {
      allowed: false,
      reason: `Automation mode is SAFE_AUTO_REPLY; rule type ${effectiveRuleType} is not eligible for automatic replies in this mode.`,
    };
  }

  if (cooldownSeconds && cooldownSeconds > 0 && !testMode) {
    const cooling = await isCooldownActive({
      accountId,
      toPhone,
      ruleId: rule?.id ?? null,
      cooldownSeconds,
    });
    if (cooling) {
      return {
        allowed: false,
        reason: `Auto-reply cooldown is active for this client and rule (${cooldownSeconds}s).`,
      };
    }
  }

  // Rate limits protect the WhatsApp number itself, so they are lifted only for a group an
  // admin has explicitly marked as a test group — never globally.
  //
  // A limit of 0 (or any non-positive value) means NO LIMIT, not "block everything". Read the
  // other way — which is what a bare `used >= limit` does, since `0 >= 0` is true — a single
  // cleared box on the Settings form silently and permanently stopped every outbound message on
  // the system, rule replies and AI replies alike, with each one reporting the self-refuting
  // "Global per-minute rate limit reached (0/0)". `rateLimitingEnabled` is the switch for turning
  // the whole mechanism off; an individual 0 is how you turn off one of the five.
  if (settings.rateLimitingEnabled && !testMode) {
    // Five independent COUNTs — fetched together, as the send-time re-check in
    // outboundQueueProcessor.ts already does, rather than in two serial round trips. The
    // precedence of the checks below is unchanged.
    const [perClient, global] = await Promise.all([
      getPerClientLimitUsage(accountId, toPhone),
      getGlobalRateLimitUsage(accountId),
    ]);

    if (exceedsLimit(perClient.perHour, settings.maxRepliesPerClientPerHour)) {
      return {
        allowed: false,
        reason: `Per-client hourly reply limit reached (${perClient.perHour}/${settings.maxRepliesPerClientPerHour}).`,
      };
    }
    if (exceedsLimit(perClient.perDay, settings.maxRepliesPerClientPerDay)) {
      return {
        allowed: false,
        reason: `Per-client daily reply limit reached (${perClient.perDay}/${settings.maxRepliesPerClientPerDay}).`,
      };
    }

    if (exceedsLimit(global.perMinute, settings.globalMaxPerMinute)) {
      return {
        allowed: false,
        reason: `Global per-minute rate limit reached (${global.perMinute}/${settings.globalMaxPerMinute}).`,
      };
    }
    if (exceedsLimit(global.perHour, settings.globalMaxPerHour)) {
      return {
        allowed: false,
        reason: `Global per-hour rate limit reached (${global.perHour}/${settings.globalMaxPerHour}).`,
      };
    }
    if (exceedsLimit(global.perDay, settings.globalMaxPerDay)) {
      return {
        allowed: false,
        reason: `Global per-day rate limit reached (${global.perDay}/${settings.globalMaxPerDay}).`,
      };
    }
  }

  return { allowed: true, reason: "All safety checks passed." };
}
