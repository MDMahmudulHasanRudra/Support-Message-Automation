/** Shared support-alert text format for both the Teams and WhatsApp notification providers. */
export function formatSupportAlert(payload: Record<string, unknown>): string {
  const group = (payload.groupId as string) ?? "(direct message)";
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
