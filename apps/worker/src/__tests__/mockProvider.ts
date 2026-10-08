import type {
  CollectionProbe,
  ConnectionStatus,
  GroupCreationResult,
  GroupInfo,
  GroupJoinResult,
  GroupParticipant,
  NumberCheckResult,
  ProfileUpdate,
  ProfileUpdateResult,
  SendResult,
  WhatsAppProvider,
} from "../provider/WhatsAppProvider.js";
import type { MediaDownloadInfo, RawIncomingMessage } from "../pipeline/types.js";

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
  /** Overridden by a test that needs the provider to report a status it is not really in. */
  public connectionStatus: ConnectionStatus = "CONNECTED";
  /**
   * Set by a watchdog test to make the probe fail. Null means "answer normally from
   * `missedMessages`" — the only behaviour every pre-existing test knows about.
   */
  public probeFailureReason: string | null = null;

  /**
   * How many times anything asked this provider to connect.
   *
   * Asserted by the collection watchdog's tests: "never retried" is the load-bearing half of how
   * AUTHENTICATION_REQUIRED is handled, and a test that only checks an alert was raised would not
   * notice a change that started reconnecting in a loop behind it, rotating a QR nobody is
   * looking at.
   */
  public connectAttempts = 0;

  async connect(): Promise<void> {
    this.connectAttempts += 1;
  }
  async disconnect(): Promise<void> {}
  async logout(): Promise<void> {
    this.loggedOut = true;
  }
  getConnectionStatus(): ConnectionStatus {
    return this.connectionStatus;
  }
  async getGroups(): Promise<GroupInfo[]> {
    return [];
  }
  /** Set by a test that exercises the catch-up sweep; nothing to replay otherwise. */
  public missedMessages: RawIncomingMessage[] = [];

  subscribeToMessages(): void {}

  async fetchMessagesSince(since: Date, limit: number): Promise<RawIncomingMessage[]> {
    const probe = await this.probeCollection(since, limit);
    return probe.ok ? probe.messages : [];
  }

  async probeCollection(since: Date, limit: number): Promise<CollectionProbe> {
    if (this.probeFailureReason) return { ok: false, reason: this.probeFailureReason };
    return { ok: true, messages: this.missedMessages.filter((m) => m.timestampWa > since).slice(0, limit) };
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

  /**
   * A roster entry WhatsApp identified by a real phone number.
   *
   * A factory rather than object literals in each test, so a fixture cannot accidentally omit
   * `rawId` — the field the whole LID distinction rests on. A literal that forgot it would
   * typecheck the day it was written and quietly become the wrong kind of participant later.
   */
  static phoneParticipant(phoneNumber: string, name: string | null = null): GroupParticipant {
    return { phoneNumber, rawId: `${phoneNumber}@c.us`, name, isSelf: false, isAdmin: null };
  }

  /**
   * A roster entry identified by a LID — an opaque id that is NOT anybody's phone number, even
   * though it is all digits and passes every length check this codebase applies to a number.
   */
  static lidParticipant(lid: string, name: string | null = null): GroupParticipant {
    return { phoneNumber: lid, rawId: `${lid}@lid`, name, isSelf: false, isAdmin: null };
  }

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

  /**
   * Which groups this account may add to. Null is the "could not tell" case and is deliberately
   * the default for nothing — a test has to opt into it, because reading null as "not an admin"
   * is the mistake the check phase must never make.
   */
  public adminGroupIds: string[] | null = null;
  /** True once a test has set `adminGroupIds`, so the default stays "unknown" rather than "none". */
  public adminGroupIdsConfigured = false;
  async getAdminGroupIds(): Promise<string[] | null> {
    return this.adminGroupIdsConfigured ? this.adminGroupIds : null;
  }

  /** Per-group admin ids for the Groups Admin Maker; a group not listed reads as unreadable (null). */
  public adminIdsByChatId = new Map<string, string[] | null>();
  async getGroupAdminIds(chatId: string): Promise<string[] | null> {
    return this.adminIdsByChatId.has(chatId) ? this.adminIdsByChatId.get(chatId)! : null;
  }

  public promotions: Array<{ chatId: string; participantId: string }> = [];
  /** Per-group results; a group not listed succeeds and the participant becomes an admin. */
  public promoteResults = new Map<string, SendResult>();
  async promoteGroupParticipant(chatId: string, participantId: string): Promise<SendResult> {
    this.promotions.push({ chatId, participantId });
    const result = this.promoteResults.get(chatId) ?? { success: true };
    if (result.success) {
      const admins = this.adminIdsByChatId.get(chatId) ?? [];
      if (!admins.includes(participantId)) this.adminIdsByChatId.set(chatId, [...admins, participantId]);
    }
    return result;
  }

  /** Fresh fetch details per WhatsApp message id; anything not listed reads as unknown (null). */
  public mediaDownloadInfo = new Map<string, MediaDownloadInfo>();
  async getMediaDownloadInfo(whatsappMessageId: string): Promise<MediaDownloadInfo | null> {
    return this.mediaDownloadInfo.get(whatsappMessageId) ?? null;
  }

  /** Per-number answers; anything not listed comes back as existing on WhatsApp. */
  public numberChecks = new Map<string, NumberCheckResult>();
  public defaultNumberCheck: NumberCheckResult = { ok: true, exists: true };
  async checkNumberOnWhatsApp(phoneNumber: string): Promise<NumberCheckResult> {
    return this.numberChecks.get(phoneNumber) ?? this.defaultNumberCheck;
  }

  public reactions: Array<{ whatsappMessageId: string; emoji: string }> = [];
  public nextReactionResult: SendResult = { success: true };
  async reactToMessage(whatsappMessageId: string, emoji: string): Promise<SendResult> {
    this.reactions.push({ whatsappMessageId, emoji });
    return this.nextReactionResult;
  }

  public edits: Array<{ whatsappMessageId: string; newBody: string }> = [];
  public nextEditResult: SendResult = { success: true };
  async editMessage(whatsappMessageId: string, newBody: string): Promise<SendResult> {
    this.edits.push({ whatsappMessageId, newBody });
    return this.nextEditResult;
  }

  public createdGroups: Array<{ groupName: string; contactPhoneNumbers: string[] }> = [];
  public nextCreateGroupResult: GroupCreationResult = { success: true, whatsappGroupId: "mock-group@g.us", name: "" };
  async createGroup(groupName: string, contactPhoneNumbers: string[]): Promise<GroupCreationResult> {
    this.createdGroups.push({ groupName, contactPhoneNumbers });
    return this.nextCreateGroupResult.success
      ? { ...this.nextCreateGroupResult, name: groupName }
      : this.nextCreateGroupResult;
  }

  public joinedInviteLinks: string[] = [];
  public nextJoinGroupResult: GroupJoinResult = { success: true, whatsappGroupId: "mock-group@g.us" };
  async joinGroupByInviteLink(inviteLink: string): Promise<GroupJoinResult> {
    this.joinedInviteLinks.push(inviteLink);
    return this.nextJoinGroupResult;
  }

  public profileUpdates: ProfileUpdate[] = [];
  public nextProfileUpdateResult: ProfileUpdateResult = { displayName: true, about: true, pictureDataUrl: true };
  async updateProfile(update: ProfileUpdate): Promise<ProfileUpdateResult> {
    this.profileUpdates.push(update);
    return this.nextProfileUpdateResult;
  }
}
