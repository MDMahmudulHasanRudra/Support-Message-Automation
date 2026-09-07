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
