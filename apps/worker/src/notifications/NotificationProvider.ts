export interface NotificationSendResult {
  success: boolean;
  error?: string;
}

export interface NotificationProvider {
  send(destination: string, payload: Record<string, unknown>): Promise<NotificationSendResult>;
}
