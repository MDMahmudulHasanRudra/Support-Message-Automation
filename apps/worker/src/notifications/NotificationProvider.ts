export interface NotificationSendResult {
  success: boolean;
  error?: string;
}

export interface NotificationProvider {
  /**
   * `accountId` is the WhatsApp account this notification was resolved to at enqueue time
   * (`Notification.accountId`) — null for provider types that have no account concept (TEAMS).
   * A WhatsApp-sending provider must use this to pick which connected account to send through,
   * never an arbitrary/first/last connected one (see resolveWhatsAppAccount()).
   */
  send(destination: string, payload: Record<string, unknown>, accountId: string | null): Promise<NotificationSendResult>;
}
