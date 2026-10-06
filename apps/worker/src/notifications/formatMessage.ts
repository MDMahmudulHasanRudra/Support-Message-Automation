import { renderNotification } from "./templates.js";

/**
 * Shared support-alert text for both the Teams and WhatsApp notification providers.
 *
 * The wording now comes from a template an operator can edit (Notification Templates), with the
 * built-in default in packages/shared/src/notificationTemplates.ts. This function's job is
 * narrowed to what it always really did: turn a loosely-typed payload into the named variables
 * that template declares, and supply a sensible stand-in for each missing one.
 *
 * Async now, because reading an override is a database call. Both providers already await their
 * send, so this costs nothing beyond one indexed primary-key lookup per notification.
 */
export async function formatSupportAlert(payload: Record<string, unknown>): Promise<string> {
  const text = (key: string): string | undefined => {
    const value = payload[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  };

  const groupName = text("groupName") ?? text("groupId") ?? "(direct message)";
  const clientName = text("clientName") ?? text("clientPhone") ?? "unknown";
  const customerMessage = (payload.message as string) ?? "";

  if (payload.alertKind === "COLLECTION_BROKEN") {
    return renderNotification("COLLECTION_BROKEN", {
      accountLabel: text("accountLabel") ?? "(unnamed account)",
      problem: text("problem") ?? "This number is not collecting messages.",
      detail: text("detail") ?? "",
      quietFor: text("quietFor") ?? "unknown",
      action: text("action") ?? "Open WhatsApp → Accounts and check this number.",
    });
  }

  if (payload.alertKind === "MOOD_ALERT") {
    return renderNotification("MOOD_ALERT", {
      moodLabel: text("moodLabel") ?? "Upset",
      priority: text("priority") ?? "HIGH",
      confidence: text("confidence") ?? "n/a",
      groupName,
      clientName,
      customerMessage,
      reasons: text("reasons") ?? "",
      trend: text("trend") ?? "",
      assignedTo: text("assignedTo") ?? "",
      conversation: text("conversation") ?? "",
      mentions: text("mentionTags") ?? "",
    });
  }

  // Support Assignment (SUPPORT_ASSIGNMENT.md): the variables were built when the notice was
  // queued (packages/db queueSupportAssignmentNotices), so the times in the message are the ones
  // the case had then, however long the send waited.
  if (payload.alertKind === "SUPPORT_ASSIGNMENT" && typeof payload.templateKey === "string" && payload.templateKey.startsWith("SUPPORT_ASSIGNMENT_")) {
    const vars = (payload.vars && typeof payload.vars === "object" ? payload.vars : {}) as Record<string, unknown>;
    return renderNotification(
      payload.templateKey,
      Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "string" ? v : null])),
    );
  }

  if (payload.alertKind === "UNKNOWN_PATTERN") {
    return renderNotification("UNKNOWN_PATTERN", {
      keywords: (payload.patternKeywords as string[] | undefined)?.join(", ") || "(pattern)",
      occurrences: String((payload.occurrences as number) ?? 0),
      groups: String((payload.groups as number) ?? 0),
      clients: String((payload.clients as number) ?? 0),
      confidence: `${(payload.confidence as number) ?? 0}%`,
      groupName: text("groupName") ?? text("groupId") ?? "(unknown group)",
      latestMessage: text("latestMessage") ?? "(no example captured)",
    });
  }

  if (payload.alertKind === "AI_ASSISTANCE_REQUIRED") {
    return renderNotification("AI_HANDOVER_ALERT", {
      groupName,
      clientName,
      customerMessage,
      confidence: payload.confidence != null ? `${payload.confidence}%` : "n/a",
      intent: text("intent") ?? "(not classified)",
      reason: text("reason") ?? "(no reason given)",
    });
  }

  return renderNotification("RULE_SUPPORT_REQUEST", {
    groupName,
    clientName,
    customerMessage,
    category: text("category") ?? "(uncategorized)",
    matchedRuleName: text("matchedRuleName") ?? "(no rule)",
  });
}
