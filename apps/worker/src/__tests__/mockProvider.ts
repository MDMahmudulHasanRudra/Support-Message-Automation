import type { WhatsAppProvider, SendResult } from "../provider/WhatsAppProvider.js";

/**
 * A mocked WhatsAppProvider for integration tests — the outbound queue
 * processor is exercised for real (safety checks, retries, status
 * transitions) without ever touching OpenWA or a live account.
 */
export class MockProvider implements WhatsAppProvider {
  public sentMessages: Array<{ chatId: string; body: string }> = [];
  public nextResult: SendResult = { success: true, providerMessageId: "mock-id" };

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  getConnectionStatus() {
    return "CONNECTED" as const;
  }
  async getGroups() {
    return [];
  }
  subscribeToMessages(): void {}
  async getAccountInfo() {
    return { phoneNumber: "+8801000000000", pushName: "Mock Account" };
  }

  async sendMessage(chatId: string, body: string): Promise<SendResult> {
    this.sentMessages.push({ chatId, body });
    return this.nextResult;
  }
}
