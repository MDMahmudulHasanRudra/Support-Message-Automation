import type { ConnectionStatus, GroupInfo, GroupParticipant, SendResult, WhatsAppProvider } from "../provider/WhatsAppProvider.js";
import type { RawIncomingMessage } from "../pipeline/types.js";

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
  public loggedOut = false;
  public addedParticipants: Array<{ chatId: string; phoneNumber: string }> = [];
  public nextAddParticipantResult: SendResult = { success: true };

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async logout(): Promise<void> {
    this.loggedOut = true;
  }
  getConnectionStatus(): ConnectionStatus {
    return "CONNECTED";
  }
  async getGroups(): Promise<GroupInfo[]> {
    return [];
  }
  /** Set by a test that exercises the catch-up sweep; nothing to replay otherwise. */
  public missedMessages: RawIncomingMessage[] = [];

  subscribeToMessages(): void {}

  async fetchMessagesSince(since: Date, limit: number): Promise<RawIncomingMessage[]> {
    return this.missedMessages.filter((message) => message.timestampWa > since).slice(0, limit);
  }
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

  /** Per-chat roster, set by a test that needs one; empty otherwise. */
  public participantsByChatId = new Map<string, GroupParticipant[]>();

  async getGroupParticipants(chatId: string): Promise<GroupParticipant[]> {
    return this.participantsByChatId.get(chatId) ?? [];
  }

  async getGroupParticipantCount(chatId: string): Promise<number | null> {
    return this.participantCountByChatId.has(chatId)
      ? this.participantCountByChatId.get(chatId)!
      : this.defaultParticipantCount;
  }

  async addGroupParticipant(chatId: string, phoneNumber: string): Promise<SendResult> {
    this.addedParticipants.push({ chatId, phoneNumber });
    return this.nextAddParticipantResult;
  }
}
