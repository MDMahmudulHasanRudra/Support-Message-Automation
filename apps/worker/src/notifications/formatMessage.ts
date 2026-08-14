/** Shared support-alert text format for both the Teams and WhatsApp notification providers. */
export function formatSupportAlert(payload: Record<string, unknown>): string {
  if (payload.alertKind === "UNKNOWN_PATTERN") {
    return formatUnknownPatternAlert(payload);
  }

  const group =
    (payload.groupName as string) ?? (payload.groupId as string) ?? "(direct message)";
  const client = (payload.clientName as string) ?? (payload.clientPhone as string) ?? "unknown";
  const message = (payload.message as string) ?? "";
  const category = (payload.category as string) ?? "(uncategorized)";
  const ruleName = (payload.matchedRuleName as string) ?? "(no rule)";

  return [
    "🚨 NEW SUPPORT REQUEST",
    "",
    `Group: ${group}`,
    `Client: ${client}`,
    `Message: ${message}`,
    `Category: ${category}`,
    `Matched Rule: ${ruleName}`,
    "",
    "Action Required: Please contact the client and resolve the issue.",
  ].join("\n");
}

/** Conversation Learning's Unknown Pattern alert — one recurring, unhandled question aggregated
 * across every occurrence rather than a per-message alert; see patternDetectionJob.ts's cooldown. */
function formatUnknownPatternAlert(payload: Record<string, unknown>): string {
  const keywords = (payload.patternKeywords as string[] | undefined)?.join(", ") || "(pattern)";
  const occurrences = (payload.occurrences as number) ?? 0;
  const groups = (payload.groups as number) ?? 0;
  const clients = (payload.clients as number) ?? 0;
  const confidence = (payload.confidence as number) ?? 0;
  const groupName = (payload.groupName as string) ?? (payload.groupId as string) ?? "(unknown group)";
  const latestMessage = (payload.latestMessage as string) ?? "(no example captured)";

  return [
    "🔍 UNKNOWN PATTERN DETECTED",
    "",
    `Pattern: ${keywords}`,
    `Evidence: ${occurrences} unhandled occurrence(s) across ${groups} group(s), ${clients} client(s)`,
    `Confidence: ${confidence}%`,
    `Latest group: ${groupName}`,
    `Latest message: ${latestMessage}`,
    "",
    "No existing rule handles this yet — review it in Conversation Learning → Unknown Patterns.",
  ].join("\n");
}
