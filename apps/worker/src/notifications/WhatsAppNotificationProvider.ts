import type { ProviderRegistry } from "../provider/ProviderRegistry.js";
import type { NotificationProvider, NotificationSendResult } from "./NotificationProvider.js";
import { formatSupportAlert } from "./formatMessage.js";

/**
 * Sends the support alert through whichever connected WhatsApp account this notification was
 * resolved to at enqueue time (see resolveWhatsAppAccount() / Notification.accountId) — reusing
 * the same WhatsAppProvider connection the worker already holds for that account, never a second
 * connection, and never an arbitrary/first/last connected account if more than one exists. The
 * destination is the group's or contact's chat id.
 *
 * Loop-prevention note: this send goes out as an OUTGOING message through
 * the provider, so it is never re-ingested as a new client message (see
 * pipeline/processIncomingMessage.ts's direction check). The support group
 * itself must not also be configured as a monitored client conversation, or
 * these alerts would appear to "arrive" there as if a client sent them.
 */
export class WhatsAppNotificationProvider implements NotificationProvider {
  constructor(private readonly registry: ProviderRegistry) {}

  async send(destination: string, payload: Record<string, unknown>, accountId: string | null): Promise<NotificationSendResult> {
    if (!accountId) {
      return { success: false, error: "Notification has no resolved WhatsApp account — refusing to guess one." };
    }
    const provider = this.registry.get(accountId);
    if (!provider) {
      return { success: false, error: `WhatsApp account ${accountId} is not connected in this worker.` };
    }
    const text = formatSupportAlert(payload);
    console.log(`[whatsapp-routing] account=${accountId} recipient=${destination} action=SEND`);
    const result = await provider.sendMessage(destination, text);
    return { success: result.success, error: result.error };
  }
}
