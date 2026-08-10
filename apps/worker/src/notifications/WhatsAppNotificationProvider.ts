import type { WhatsAppProvider } from "../provider/WhatsAppProvider.js";
import type { NotificationProvider, NotificationSendResult } from "./NotificationProvider.js";
import { formatSupportAlert } from "./formatMessage.js";

/**
 * Sends the support alert to the configured internal WhatsApp support group,
 * reusing the same WhatsAppProvider connection the worker already holds —
 * never a second connection. The destination is the group's chat id.
 *
 * Loop-prevention note: this send goes out as an OUTGOING message through
 * the provider, so it is never re-ingested as a new client message (see
 * pipeline/processIncomingMessage.ts's direction check). The support group
 * itself must not also be configured as a monitored client conversation, or
 * these alerts would appear to "arrive" there as if a client sent them.
 */
export class WhatsAppNotificationProvider implements NotificationProvider {
  constructor(private readonly provider: WhatsAppProvider) {}

  async send(destination: string, payload: Record<string, unknown>): Promise<NotificationSendResult> {
    const text = formatSupportAlert(payload);
    const result = await this.provider.sendMessage(destination, text);
    return { success: result.success, error: result.error };
  }
}
