import { prisma } from "@support-automation/db";
import { NOTIFICATION_TEMPLATES } from "@support-automation/shared";

/**
 * Whether each template can currently reach anybody, and what to switch on if not.
 *
 * Without this the page invites a specific waste: somebody carefully rewrites the escalation
 * wording, saves it, and it never sends because escalation alerts are muted in Notification
 * Center — with nothing on screen to suggest that. Editing dead settings is the failure this
 * project keeps removing elsewhere; a template editor that hides it would reintroduce it.
 *
 * Read-only and best effort. Every check is a reason to add a note, never to disable the editor —
 * somebody switching a feature on next week should be able to prepare its wording today.
 */

export interface TemplateLiveness {
  live: boolean;
  /** Why it cannot send right now, in the operator's terms. */
  reason?: string;
  fixHref?: string;
  fixLabel?: string;
}

const NOTIFICATION_CENTER = { fixHref: "/notifications/events", fixLabel: "Notification Center" };
const AI_SETTINGS = { fixHref: "/ai-learning/settings", fixLabel: "AI Settings" };

export async function getTemplateLiveness(): Promise<Record<string, TemplateLiveness>> {
  const [aiSettings, learning, eventSettings, notifyRules, priorityGroupCount] = await Promise.all([
    prisma.aiSettings.findUnique({ where: { id: "global" } }),
    prisma.learningSettings.findUnique({ where: { id: "global" } }),
    prisma.notificationEventSetting.findMany(),
    // AutomationRule.actions is a Json column rather than a relation, so this cannot be a `count`
    // with a nested filter. Active rules number in the single digits here, so reading their
    // actions and checking in memory is cheaper than a JSONB query nobody can read.
    prisma.automationRule.findMany({ where: { status: "ACTIVE" }, select: { actions: true } }),
    prisma.whatsAppGroup.count({ where: { isActive: true, priority: { not: null } } }),
  ]);

  const notifyRuleCount = notifyRules.filter((rule) =>
    Array.isArray(rule.actions)
      ? rule.actions.some(
          (action) =>
            typeof action === "object" &&
            action !== null &&
            "actionType" in action &&
            (action.actionType === "NOTIFY_WHATSAPP" || action.actionType === "NOTIFY_TEAMS"),
        )
      : false,
  ).length;

  const byEvent = new Map(eventSettings.map((row) => [row.event, row]));
  // Absent row means "never configured", which behaves as fully enabled — the same reading
  // getEventDelivery() uses. Treating it as off here would show every template as dead on a
  // deployment that has simply never opened that page.
  const eventEnabled = (event: string) => byEvent.get(event as never)?.enabled ?? true;

  const aiLayerOn = Boolean(aiSettings?.aiEngineEnabled && aiSettings?.autoResponseEnabled);
  const status: Record<string, TemplateLiveness> = {};

  for (const definition of NOTIFICATION_TEMPLATES) {
    status[definition.key] = computeOne(definition.key, {
      aiLayerOn,
      mentionOn: Boolean(aiSettings?.mentionTeamOnHandover),
      learningOn: Boolean(learning?.conversationLearningEnabled),
      unknownPatternAlertsOn: Boolean(learning?.unknownPatternNotificationsEnabled),
      eventEnabled,
      notifyRuleCount,
      priorityGroupCount,
    });
  }

  return status;
}

interface Inputs {
  aiLayerOn: boolean;
  mentionOn: boolean;
  learningOn: boolean;
  unknownPatternAlertsOn: boolean;
  eventEnabled: (event: string) => boolean;
  notifyRuleCount: number;
  priorityGroupCount: number;
}

function computeOne(key: string, input: Inputs): TemplateLiveness {
  if (key === "AI_HANDOVER_ALERT") {
    if (!input.aiLayerOn) {
      return { live: false, reason: "AI automation is off, so nothing hands over yet.", ...AI_SETTINGS };
    }
    if (!input.eventEnabled("AI_HUMAN_FALLBACK")) {
      return { live: false, reason: "Handover alerts are muted.", ...NOTIFICATION_CENTER };
    }
    return { live: true };
  }

  if (key === "AI_HANDOVER_MENTION") {
    if (!input.mentionOn) {
      return {
        live: false,
        reason: "Tagging a team member in the customer's own group is off, so this message is never posted.",
        ...AI_SETTINGS,
      };
    }
    if (!input.aiLayerOn) {
      return { live: false, reason: "AI automation is off, so nothing hands over yet.", ...AI_SETTINGS };
    }
    return { live: true };
  }

  if (key === "RULE_SUPPORT_REQUEST") {
    if (!input.eventEnabled("RULE_NOTIFY_WHATSAPP") && !input.eventEnabled("RULE_NOTIFY_TEAMS")) {
      return { live: false, reason: "Rule alerts are muted on both channels.", ...NOTIFICATION_CENTER };
    }
    if (input.notifyRuleCount === 0) {
      // Not a mute — nothing raises it. Different cause, different fix, so it says so.
      return {
        live: false,
        reason: "No active rule has a notify action, so nothing raises this alert.",
        fixHref: "/rules",
        fixLabel: "Automation Rules",
      };
    }
    return { live: true };
  }

  if (key === "UNKNOWN_PATTERN") {
    if (!input.learningOn) {
      return {
        live: false,
        reason: "Conversation Learning is off, so patterns are never detected.",
        fixHref: "/conversation-learning/settings",
        fixLabel: "Conversation Settings",
      };
    }
    if (!input.unknownPatternAlertsOn) {
      return {
        live: false,
        reason: "Unknown-pattern alerts are switched off.",
        fixHref: "/conversation-learning/settings",
        fixLabel: "Conversation Settings",
      };
    }
    if (!input.eventEnabled("UNKNOWN_PATTERN")) {
      return { live: false, reason: "Unknown-pattern alerts are muted.", ...NOTIFICATION_CENTER };
    }
    return { live: true };
  }

  if (key === "COLLECTION_BROKEN") {
    if (!input.eventEnabled("COLLECTION_BROKEN")) {
      return { live: false, reason: "Collection-failure alerts are muted.", ...NOTIFICATION_CENTER };
    }
    // Deliberately no "nothing raises it yet" branch. The watchdog runs unconditionally and needs
    // no feature switched on, so the only way this template is dead is if somebody muted it — and
    // saying anything softer would understate what muting it costs.
    return { live: true };
  }

  if (key.startsWith("ESCALATION_")) {
    if (!input.eventEnabled("SUPPORT_ESCALATION")) {
      return { live: false, reason: "Escalation alerts are muted.", ...NOTIFICATION_CENTER };
    }
    if (input.priorityGroupCount === 0) {
      // Escalation is SLA-timer driven rather than flag driven, so there is no switch to blame —
      // it simply has no cases to open until a group carries a priority tier.
      return {
        live: false,
        reason: "No group has a priority tier, so no escalation case is ever opened.",
        fixHref: "/groups",
        fixLabel: "Groups",
      };
    }
    return { live: true };
  }

  return { live: true };
}
