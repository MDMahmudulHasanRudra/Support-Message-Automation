import type { GroupInfo, SendResult, WhatsAppProvider } from "../provider/WhatsAppProvider.js";

/**
 * A mocked WhatsAppProvider for integration tests — the outbound queue
 * processor is exercised for real (safety checks, retries, status
 * transitions) without ever touching OpenWA or a live account.
 */
export class MockProvider implements WhatsAppProvider {
  public sentMessages: Array<{ chatId: string; body: string }> = [];
  public nextResult: SendResult = { success: true, providerMessageId: "mock-id" };
  /** Test-controllable: defaults to "yes, still a member" so existing tests don't need to know about this. */
  public membershipByChatId: Map<string, boolean> = new Map();
  public defaultMembership = true;
  public participantCountByChatId: Map<string, number | null> = new Map();
  public defaultParticipantCount: number | null = 42;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  getConnectionStatus() {
    return "CONNECTED" as const;
  }
  async getGroups(): Promise<GroupInfo[]> {
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

  async verifyGroupMembership(chatId: string): Promise<boolean> {
    return this.membershipByChatId.get(chatId) ?? this.defaultMembership;
  }

  async getGroupParticipantCount(chatId: string): Promise<number | null> {
    return this.participantCountByChatId.has(chatId)
      ? this.participantCountByChatId.get(chatId)!
      : this.defaultParticipantCount;
  }
}
