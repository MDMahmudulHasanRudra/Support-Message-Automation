import type { RawIncomingMessage } from "../pipeline/types.js";

export type ConnectionStatus =
  | "CONNECTED"
  | "DISCONNECTED"
  | "RECONNECTING"
  | "AUTHENTICATION_REQUIRED"
  | "SESSION_ERROR"
  | "ERROR";

export interface GroupInfo {
  whatsappGroupId: string;
  name: string;
}

export interface AccountInfo {
  phoneNumber: string | null;
  pushName: string | null;
}

export interface SendResult {
  success: boolean;
  providerMessageId?: string;
  error?: string;
}

/**
 * The core rule engine, pipeline, and queue processor depend only on this
 * interface — never on OpenWA directly (see ARCHITECTURE.md). A future
 * official WhatsApp Business Platform provider is a drop-in implementation.
 */
export interface WhatsAppProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getConnectionStatus(): ConnectionStatus;
  getGroups(): Promise<GroupInfo[]>;
  subscribeToMessages(handler: (message: RawIncomingMessage) => void): void;
  sendMessage(chatId: string, body: string): Promise<SendResult>;
  getAccountInfo(): Promise<AccountInfo>;
}
