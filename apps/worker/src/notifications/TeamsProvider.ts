import type { NotificationProvider, NotificationSendResult } from "./NotificationProvider.js";
import { formatSupportAlert } from "./formatMessage.js";

/** Posts a support-alert card to a Microsoft Teams incoming webhook URL (the `destination`). */
export class TeamsProvider implements NotificationProvider {
  async send(destination: string, payload: Record<string, unknown>): Promise<NotificationSendResult> {
    const text = formatSupportAlert(payload);
    try {
      const response = await fetch(destination, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        return { success: false, error: `Teams webhook responded with HTTP ${response.status}` };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
}
