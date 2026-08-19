import { prisma } from "@support-automation/db";
import type { AutomationSettings } from "@prisma/client";
import { isCooldownActive } from "../queue/cooldown.js";
import { getGlobalRateLimitUsage, getPerClientLimitUsage } from "../queue/rateLimiter.js";
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
  const SAFE_MODE_ELIGIBLE_TYPES = new Set(["AUTO_REPLY", "SUPPORT_ESCALATION"]);
  const effectiveRuleType = rule?.type ?? "AUTO_REPLY";
  if (settings.mode === "SAFE_AUTO_REPLY" && !SAFE_MODE_ELIGIBLE_TYPES.has(effectiveRuleType)) {
    return {
      allowed: false,
      reason: `Automation mode is SAFE_AUTO_REPLY; rule type ${effectiveRuleType} is not eligible for automatic replies in this mode.`,
    };
  }

  if (!toPhone) {
    return { allowed: false, reason: "Destination phone number is missing or invalid." };
  }

  if (groupId) {
    const group = await prisma.whatsAppGroup.findUnique({
      where: { id: groupId },
      select: { isMonitored: true },
    });
    if (!group?.isMonitored) {
      return { allowed: false, reason: "The message's group is not a monitored conversation." };
    }
  }

  if (rule && cooldownSeconds && cooldownSeconds > 0) {
    const cooling = await isCooldownActive({
      accountId,
      toPhone,
      ruleId: rule.id,
      cooldownSeconds,
    });
    if (cooling) {
      return {
        allowed: false,
        reason: `Auto-reply cooldown is active for this client and rule (${cooldownSeconds}s).`,
      };
    }
  }

  if (settings.rateLimitingEnabled) {
    const perClient = await getPerClientLimitUsage(accountId, toPhone);
    if (perClient.perHour >= settings.maxRepliesPerClientPerHour) {
      return {
        allowed: false,
        reason: `Per-client hourly reply limit reached (${perClient.perHour}/${settings.maxRepliesPerClientPerHour}).`,
      };
    }
    if (perClient.perDay >= settings.maxRepliesPerClientPerDay) {
      return {
        allowed: false,
        reason: `Per-client daily reply limit reached (${perClient.perDay}/${settings.maxRepliesPerClientPerDay}).`,
      };
    }

    const global = await getGlobalRateLimitUsage(accountId);
    if (global.perMinute >= settings.globalMaxPerMinute) {
      return {
        allowed: false,
        reason: `Global per-minute rate limit reached (${global.perMinute}/${settings.globalMaxPerMinute}).`,
      };
    }
    if (global.perHour >= settings.globalMaxPerHour) {
      return {
        allowed: false,
        reason: `Global per-hour rate limit reached (${global.perHour}/${settings.globalMaxPerHour}).`,
      };
    }
    if (global.perDay >= settings.globalMaxPerDay) {
      return {
        allowed: false,
        reason: `Global per-day rate limit reached (${global.perDay}/${settings.globalMaxPerDay}).`,
      };
    }
  }

  return { allowed: true, reason: "All safety checks passed." };
}
