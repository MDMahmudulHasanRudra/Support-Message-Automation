import type { MediaDownloadInfo, RawIncomingMessage } from "../pipeline/types.js";

export type ConnectionStatus =
  | "CONNECTED"
  | "DISCONNECTED"
  | "RECONNECTING"
  | "AUTHENTICATION_REQUIRED"
  | "SESSION_ERROR"
  | "ERROR";

export interface GroupParticipant {
  /** Digits only, already stripped of the WhatsApp JID domain. */
  phoneNumber: string;
  /**
   * The id exactly as WhatsApp gave it, domain and all — `8801…@c.us`, or `1234567890123@lid`.
   *
   * Kept because the domain is the ONLY thing that distinguishes a phone number from a LID, and
   * `phoneNumber` above throws it away. A LID is an opaque 14–15 digit id deliberately unrelated
   * to anybody's number, and `normalizePhoneNumber` accepts 8–15 digits — so once stripped, a LID
   * is indistinguishable from a real number and silently fails to match the person it belongs to.
   * For a membership check that mistake reads as "not a member" and spends a redundant add on
   * somebody already in the group, which is the single operation WhatsApp punishes hardest.
   */
  rawId: string;
  /** WhatsApp display name, when the contact exposes one. */
  name: string | null;
  /** True for the account this worker is signed in as — never a colleague to add to a roster. */
  isSelf: boolean;
  /** Whether this participant can add others. Null when the provider could not say. */
  isAdmin: boolean | null;
}

/** Whether a number has a WhatsApp account at all, or why we could not find out. */
export type NumberCheckResult =
  | { ok: true; exists: boolean }
  | { ok: false; reason: string };

export interface GroupInfo {
  whatsappGroupId: string;
  name: string;
}

/**
 * The session cannot list its groups, and trying again in ten seconds will not change that — it
 * needs somebody to reconnect or re-link the account.
 *
 * Thrown by `getGroups()` so the group sync can tell this apart from a transient failure. Without
 * it a sync against a logged-out session retried twice into the same dead page, and the operator
 * read "Cannot read properties of undefined (reading 'map')" three times — a crash inside WhatsApp
 * Web's page that named nothing they could act on.
 */
export class SessionNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionNotReadyError";
  }
}

/**
 * The session is fine, but WhatsApp Web cannot give a trustworthy group list yet: its chat list is
 * still completely empty (the phone has not sent this number's chats), or a read of it did not
 * finish in time. Never "this account has no groups" — that answer is only ever an empty list from
 * a chat store that holds chats. The post-connect sync and the arrival passes treat it as "still
 * loading"; an ordinary sync treats it as a failure worth retrying.
 */
export class GroupListNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupListNotReadyError";
  }
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

/** What was created, or why not — never a bare boolean, since a group name alone tells nobody its id. */
export type GroupCreationResult =
  | { success: true; whatsappGroupId: string; name: string }
  | { success: false; error: string };

/** What was joined, or why not — mirrors GroupCreationResult so callers handle the two the same way. */
export type GroupJoinResult =
  | { success: true; whatsappGroupId: string }
  | { success: false; error: string };

export interface ProfileUpdate {
  /** WhatsApp's own display name for this account. */
  displayName?: string;
  /** The "About" text shown on the account's profile. */
  about?: string;
  /** A data URL (`data:image/...;base64,...`) for the new profile photo. */
  pictureDataUrl?: string;
}

export interface ProfileUpdateResult {
  /** True per field the provider actually confirmed changing — a caller that asked for all three
   *  and got two back knows exactly which one to retry, rather than treating the whole call as
   *  failed or succeeded. */
  displayName?: boolean;
  about?: boolean;
  pictureDataUrl?: boolean;
}

/**
 * What the browser can say about what it has seen — including that it cannot say anything.
 *
 * `fetchMessagesSince` deliberately swallows its own failures and returns an empty array, which is
 * right for catch-up: a sweep that cannot read history has simply recovered nothing, and throwing
 * would take down the connection it just finished establishing.
 *
 * It is exactly wrong for a watchdog. "WhatsApp holds nothing newer" and "WhatsApp could not be
 * asked" are opposite findings — the first is a quiet afternoon, the second is very likely the
 * failure being hunted — and collapsing them is what let a broken browser log "quiet for 195m and
 * WhatsApp agrees". A probe that can return `ok: false` is what makes the distinction expressible
 * at all; everything the watchdog does with it depends on this type.
 */
export type CollectionProbe =
  | { ok: true; messages: RawIncomingMessage[] }
  | { ok: false; reason: string };

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
  /**
   * Registers the one handler every incoming message is delivered to.
   *
   * The implementation must keep the handler wired across its own reconnects — a provider that
   * attaches it once, to whatever session happened to be live at registration, goes quiet forever
   * the first time that session is rebuilt, and reports itself perfectly healthy while doing so.
   * Safe to call before connect().
   */
  subscribeToMessages(handler: (message: RawIncomingMessage) => void): void;
  /**
   * Messages the provider can still see for chats touched since `since`, oldest first, capped at
   * `limit`.
   *
   * This is how a gap in collection gets closed. Live delivery is a push: anything that arrives
   * while the process is down, restarting, or between sessions is simply never delivered, and no
   * amount of reconnect logic recovers it — the event has already been and gone. Implementations
   * return an empty array rather than throwing; a provider with no history to offer is a weaker
   * guarantee, not a broken one.
   */
  fetchMessagesSince(since: Date, limit: number): Promise<RawIncomingMessage[]>;
  /**
   * The same read as `fetchMessagesSince`, but able to report that it failed.
   *
   * Used only by the collection watchdog, which is asking a different question: not "what can I
   * recover" but "can this session still see anything at all". An implementation must return
   * `ok: false` whenever the answer is genuinely unknown rather than empty — a dead browser, a
   * chat enumeration that threw, or a roster that came back with zero chats, which for an account
   * known to be in monitored groups is not a fact about WhatsApp but a fact about the session.
   */
  probeCollection(since: Date, limit: number): Promise<CollectionProbe>;
  /**
   * Cheap check that a session reporting CONNECTED still has a working WhatsApp inside it. When it
   * plainly does not, the provider records itself DISCONNECTED so ordinary drop recovery brings it
   * back. Optional: a provider that cannot tell simply does not implement it.
   */
  checkSessionHealth?(): Promise<void>;
  /** Told when every automatic connect attempt has failed, so it can record whether that needs a person. */
  recordLinkingGaveUp?(): Promise<void>;
  /**
   * `mentions` are contact ids ("<digits>@c.us") to tag. WhatsApp only notifies a mentioned person
   * if they are a participant of that chat; tagging someone who is not simply renders as text.
   */
  sendMessage(chatId: string, body: string, mentions?: string[]): Promise<SendResult>;
  getAccountInfo(): Promise<AccountInfo>;
  /**
   * Lightweight, single-chat membership check used by the Group Message
   * Sender immediately before sending (see safety requirement: never send
   * blindly). Deliberately NOT a full `getGroups()` rescan — that call is
   * expensive enough on large accounts to need its own timeout/retry
   * wrapper (see commandProcessor.ts) and is unsuitable to run per-message.
   * Returns false (never throws) if membership can't be confirmed.
   */
  verifyGroupMembership(chatId: string): Promise<boolean>;
  /**
   * On-demand, single-group participant count. Deliberately NOT part of
   * getGroups()/the bulk sync path — fetching full participant metadata for
   * every group in one call is far more expensive than fetching names alone
   * (see Group Management audit). Returns null (never throws) if the count
   * can't be determined.
   */
  getGroupParticipantCount(chatId: string): Promise<number | null>;
  /**
   * On-demand roster for a single group: who is actually in it, according to WhatsApp.
   *
   * Distinct from reading `Message.senderPhone` history, which only ever knows the people who
   * have spoken since this app started watching — no use at all for a group that is quiet, or
   * one being set up before any traffic exists. Same on-demand, never-in-bulk-sync reasoning as
   * getGroupParticipantCount above: full participant metadata for every group at once is far
   * more expensive than fetching names alone. Returns an empty array (never throws) if the
   * roster cannot be read.
   */
  getGroupParticipants(chatId: string): Promise<GroupParticipant[]>;
  /**
   * Adds a phone number as a participant of the given group (used by the
   * "Add to Groups" module). The digits-only `phoneNumber` is the caller's
   * responsibility to validate/normalize before this is called — this
   * method only turns it into the provider's own contact id format.
   * Never throws: provider-level failures (not an admin, contact doesn't
   * exist, group doesn't exist, etc.) come back as `{ success: false, error }`.
   */
  addGroupParticipant(chatId: string, phoneNumber: string): Promise<SendResult>;
  /**
   * Which groups this account is an admin of — WhatsApp refuses every add to a group where it is
   * not, so this is what turns INSUFFICIENT_PERMISSIONS from a failure discovered one add at a
   * time into something the whole job can be told before it starts.
   *
   * One call answers for every group, so the check phase asks once rather than per group. Returns
   * null (never throws) when it could not be determined — which must not be read as "not an
   * admin", since that would refuse work the account is perfectly able to do.
   */
  getAdminGroupIds(): Promise<string[] | null>;
  /**
   * One group's admins, by participant id exactly as WhatsApp gives it (`…@c.us` or `…@lid`).
   * Used by the Groups Admin Maker to tell "already an admin" from "needs promoting". Returns null
   * (never throws) when it could not be read — which must not be read as "no admins".
   */
  getGroupAdminIds(chatId: string): Promise<string[] | null>;
  /**
   * Makes an EXISTING member of the group an admin. Never adds anybody: WhatsApp answers
   * `NOT_A_PARTICIPANT` for somebody who is not in the group. Never throws; WhatsApp's own status
   * code (INSUFFICIENT_PERMISSIONS, NOT_A_PARTICIPANT, GROUP_DOES_NOT_EXIST, NOT_A_GROUP_CHAT) or the
   * error text comes back in `error`.
   */
  promoteGroupParticipant(chatId: string, participantId: string): Promise<SendResult>;
  /**
   * What it takes to fetch one stored message's attachment — read fresh from the live session.
   * The media worker asks only when the message itself arrived without these details (a message
   * recovered from history can). Null (never throws) when the session cannot say.
   */
  getMediaDownloadInfo(whatsappMessageId: string): Promise<MediaDownloadInfo | null>;
  /**
   * Whether a number has a WhatsApp account. A network call per number, so the check phase asks
   * once per distinct number rather than once per (number, group) pair.
   *
   * Structured rather than a bare boolean because "no account exists" and "we could not ask" lead
   * to opposite decisions: the first is a settled answer an operator should see, the second is a
   * reason to retry.
   */
  checkNumberOnWhatsApp(phoneNumber: string): Promise<NumberCheckResult>;
  /**
   * Ends the current session and invalidates its persisted session data, so the NEXT connect()
   * requires a fresh QR scan — distinct from disconnect(), which is a transient step inside
   * RECONNECT that expects the same session to be reusable afterward. Never throws; failures are
   * logged and swallowed since the caller (the LOGOUT command) must still report a clean local
   * DISCONNECTED state either way (see OpenWAProvider's doc comment on why this call is risky).
   */
  logout(): Promise<void>;
  /**
   * Reacts to an existing message with a single emoji — ours or a customer's, since WhatsApp
   * allows reacting to either. `whatsappMessageId` is the same id already stored on `Message`, so
   * no separate lookup is needed to target one. Never throws; a failure (message too old,
   * message deleted, session dropped) comes back as `{ success: false, error }`.
   */
  reactToMessage(whatsappMessageId: string, emoji: string): Promise<SendResult>;
  /**
   * Edits the text of a message THIS ACCOUNT sent. WhatsApp's own edit feature is marked
   * experimental by the underlying library and most accounts do not have it enabled — a `false`
   * result here is the ordinary outcome on an account without access, not evidence of a bug.
   * Never throws.
   */
  editMessage(whatsappMessageId: string, newBody: string): Promise<SendResult>;
  /**
   * Creates a new WhatsApp group with this account as its first member, adding the given contacts.
   * The created group is NOT written into `WhatsAppGroup` by this call — the next group sync
   * upserts it with every flag at its default, exactly like any other newly-discovered group, so
   * an admin still has to opt it into monitoring deliberately. Never throws.
   */
  createGroup(groupName: string, contactPhoneNumbers: string[]): Promise<GroupCreationResult>;
  /**
   * Joins a group via its invite link (`https://chat.whatsapp.com/<code>`). Same non-write
   * behaviour as `createGroup`: the joined group is picked up by the next sync, not written here.
   * Never throws.
   */
  joinGroupByInviteLink(inviteLink: string): Promise<GroupJoinResult>;
  /**
   * Updates this account's own WhatsApp profile — display name, About text, and/or photo. Fields
   * left undefined in `update` are left untouched; this is a partial update, never a full
   * overwrite of everything the caller did not think to pass. Never throws; a field the provider
   * could not confirm changing is simply absent (or false) in the result, not an exception.
   */
  updateProfile(update: ProfileUpdate): Promise<ProfileUpdateResult>;
}
