import { prisma } from "@support-automation/db";
import {
  getTemplateDefinition,
  renderNotificationTemplate,
  validateTemplateBody,
} from "@support-automation/shared";
import { logSystemEvent } from "../logging/logSystemEvent.js";

/**
 * Renders one notification from its template, custom if somebody edited it and built-in otherwise.
 *
 * **Never throws, and never returns nothing.** Every caller here is about to send an alert that
 * somebody is waiting on — an escalation nobody sees is a customer nobody sees. So a missing row,
 * an unreadable database, or a custom body that has somehow become invalid all fall through to the
 * built-in wording rather than failing the send. That is the same fail-open reasoning as
 * `getEventDelivery()`, and for the same reason: a slightly wrong alert is noise, a dropped one is
 * an incident.
 *
 * Re-validating a stored body before using it is not paranoia about the save path — it is about
 * time. A template saved against an older version of the catalogue can name a variable that no
 * longer exists, and that would reach a customer as a literal `{{oldName}}`.
 */
export async function renderNotification(
  key: string,
  vars: Record<string, string | null | undefined>,
): Promise<string> {
  const definition = getTemplateDefinition(key);
  if (!definition) {
    // A key with no definition is a programming error, not an operator one — but it must still not
    // take the notification down with it.
    await logSystemEvent("ERROR", "notifications", "Unknown notification template requested", { key });
    return Object.entries(vars)
      .filter(([, value]) => value)
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n");
  }

  let body = definition.defaultBody;

  try {
    const custom = await prisma.notificationTemplate.findUnique({ where: { key } });
    if (custom) {
      const verdict = validateTemplateBody(key, custom.body);
      if (verdict.error) {
        await logSystemEvent("WARN", "notifications", "Custom notification template is no longer valid — using the built-in", {
          key,
          reason: verdict.error,
        });
      } else {
        body = custom.body;
      }
    }
  } catch (err) {
    await logSystemEvent("WARN", "notifications", "Could not read a custom notification template — using the built-in", {
      key,
      error: (err as Error).message,
    });
  }

  const rendered = renderNotificationTemplate(body, vars).trim();
  // An edit that renders to nothing once the variables are filled in — every line was a lone
  // placeholder that happened to be empty — must not send a blank message.
  return rendered || renderNotificationTemplate(definition.defaultBody, vars).trim();
}
