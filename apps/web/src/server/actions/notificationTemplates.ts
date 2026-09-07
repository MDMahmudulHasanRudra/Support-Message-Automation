"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { isNotificationTemplateKey, validateTemplateBody } from "@support-automation/shared";
import { requireSession } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";

/**
 * Saving and resetting the wording of the messages this system sends.
 *
 * Two things are load-bearing here:
 *
 * **Reset deletes the row.** It does not write the current default into the table. An unedited
 * template then keeps tracking whatever the built-in wording becomes, which is the whole reason
 * defaults live in code — copying them into the database on reset would freeze each one at
 * whatever it happened to say on the day somebody clicked the button.
 *
 * **Validation happens here, not only in the browser.** A placeholder that does not exist renders
 * as a literal `{{typo}}` in front of a customer, and the client-side check is a convenience that
 * a stale tab or a direct action call goes straight past.
 */

export interface TemplateActionState {
  error?: string;
  saved?: boolean;
}

export async function updateNotificationTemplate(
  _prev: TemplateActionState,
  formData: FormData,
): Promise<TemplateActionState> {
  const session = await requireSession();

  const key = String(formData.get("key") ?? "");
  if (!isNotificationTemplateKey(key)) return { error: "That template does not exist." };

  const body = String(formData.get("body") ?? "").replace(/\r\n/g, "\n");
  const verdict = validateTemplateBody(key, body);
  if (verdict.error) return { error: verdict.error };

  await prisma.notificationTemplate.upsert({
    where: { key },
    update: { body: body.trim(), updatedById: session.userId },
    create: { key, body: body.trim(), updatedById: session.userId },
  });

  // WARN rather than INFO: this changes what customers and on-call staff actually read, and when
  // an alert later reads oddly the first question is when the wording last moved.
  await logSystemEvent("WARN", "notifications", `Notification template "${key}" edited`, {
    key,
    editedBy: session.username,
  });

  revalidatePath("/notifications/templates");
  return { saved: true };
}

export async function resetNotificationTemplate(key: string): Promise<TemplateActionState> {
  const session = await requireSession();
  if (!isNotificationTemplateKey(key)) return { error: "That template does not exist." };

  // deleteMany, not delete: resetting a template nobody had customised is a no-op the operator
  // should not see an error for.
  const { count } = await prisma.notificationTemplate.deleteMany({ where: { key } });
  if (count > 0) {
    await logSystemEvent("WARN", "notifications", `Notification template "${key}" reset to default`, {
      key,
      resetBy: session.username,
    });
  }

  revalidatePath("/notifications/templates");
  return { saved: true };
}
