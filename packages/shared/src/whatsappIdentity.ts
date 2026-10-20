import { normalizePhoneNumber } from "./groupParticipantAdd.js";
import { outgoingActorFor, type IntelActor } from "./intelligence/model.js";

/**
 * WhatsApp identity: which roster member (InternalTeamMember) sent a message, decided ONE way for
 * the whole product (WHATSAPP_IDENTITY.md).
 *
 * Before this existed the decision was made six different ways. The worker preferred a WhatsApp-id
 * match and then a phone match, among ACTIVE members, first row wins. The Team Report, the Support
 * Intelligence loader, the Call Activity report and the group reports each built a flat
 * identifier→member map with no precedence between the two kinds of identifier — three of them
 * first-row-wins (in name order, or in whatever order the database returned), one last-row-wins —
 * so one sender could be one person live and another person in a report. And nothing noticed when
 * a sender's WhatsApp id pointed at one member while their number pointed at another: whichever
 * came first simply won, and every report built on it was quietly wrong.
 *
 * The rules, all pure and unit-tested:
 *
 *  1. A sender id is read with its domain when we have it (`Message.senderJid`). A group, broadcast
 *     or channel id is NOT A PERSON and never matches anybody — a message whose author WhatsApp did
 *     not name falls back to the group's own id, and that id is no colleague's.
 *  2. Two kinds of evidence: the member's `whatsappId`, compared EXACTLY (a LID is an opaque id with
 *     no format a person could have typed wrongly), and the member's `phoneNumber`, compared digits-
 *     only on both sides (people type "+880 17…", WhatsApp delivers "88017…").
 *  3. One member named by every piece of evidence → that member. The method is recorded.
 *  4. The WhatsApp id names one member and the phone digits name ANOTHER → CONFLICT. Nobody is
 *     credited. Neither kind of evidence silently overrides the other.
 *  5. Two members share the same identifier → AMBIGUOUS. Nobody is credited.
 *  6. Nothing matches → UNRESOLVED: a customer, or a colleague nobody has put on the roster yet.
 *
 * CONFLICT and AMBIGUOUS still say `isRosterMember: true`: every candidate is a colleague, so the
 * message is certainly from the team even though WHICH colleague is unknown. That keeps the
 * product's safety behaviour (never auto-reply to staff, never open a customer wait for them)
 * while the attribution waits for a person to fix the roster.
 *
 * Which members are passed in is the caller's decision: the live pipeline passes ACTIVE members (a
 * departed colleague is a customer again), reports pass everyone (history keeps its owner).
 */

/** What kind of thing a WhatsApp id names. */
export type WhatsAppIdKind =
  /** `…@c.us` / `…@s.whatsapp.net`: a phone number. */
  | "PHONE"
  /** `…@lid`: WhatsApp's opaque per-person id. Deliberately NOT a phone number. */
  | "LID"
  /** `…@g.us`: a group. Never a person. */
  | "GROUP"
  /** `…@broadcast` (status updates, broadcast lists). Never a person. */
  | "BROADCAST"
  /** `…@newsletter` (channels). Never a person. */
  | "NEWSLETTER"
  /** No domain: a stored id whose domain was stripped before `senderJid` existed. */
  | "UNKNOWN";

export interface ParsedWhatsAppId {
  kind: WhatsAppIdKind;
  /** The part before the domain, device suffix removed: "8801712345678", "161679983804516". */
  user: string;
}

const DOMAIN_KINDS: Record<string, WhatsAppIdKind> = {
  "c.us": "PHONE",
  "s.whatsapp.net": "PHONE",
  lid: "LID",
  "g.us": "GROUP",
  broadcast: "BROADCAST",
  newsletter: "NEWSLETTER",
};

/**
 * Reads one WhatsApp id. Null for nothing usable. An unknown domain is reported as UNKNOWN rather
 * than guessed, and so is a bare id (no domain at all).
 */
export function parseWhatsAppId(raw: string | null | undefined): ParsedWhatsAppId | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const at = value.lastIndexOf("@");
  const userPart = at >= 0 ? value.slice(0, at) : value;
  const domain = at >= 0 ? value.slice(at + 1).toLowerCase() : "";
  // A multi-device id carries the device after a colon ("8801…:12@s.whatsapp.net"); the person is
  // the part before it.
  const user = userPart.split(":")[0]!.trim();
  if (!user) return null;
  return { kind: domain ? (DOMAIN_KINDS[domain] ?? "UNKNOWN") : "UNKNOWN", user };
}

/** Whether an id names a person at all (a group, broadcast or channel id never does). */
export function isPersonKind(kind: WhatsAppIdKind): boolean {
  return kind === "PHONE" || kind === "LID" || kind === "UNKNOWN";
}

/**
 * The key a stored `InternalTeamMember.whatsappId` is compared on: trimmed, domain and device
 * suffix removed. The Team Members form already stores it that way; older rows may not.
 */
export function whatsappIdKey(value: string | null | undefined): string | null {
  return parseWhatsAppId(value)?.user ?? null;
}

export interface RosterIdentity {
  id: string;
  phoneNumber: string;
  whatsappId: string | null;
  /**
   * Messages before this moment are never credited to this member (`InternalTeamMember.attributeFrom`,
   * Phase 2): a customer's number that later joins the team keeps its customer history. Null or
   * absent: every message counts, as it always did. Applied only when `resolve` is given the
   * message's time — reports do; the live pipeline does not, so anyone on the roster is staff now.
   */
  attributeFrom?: Date | number | null;
}

export type SenderMatchStatus =
  /** Only the member's WhatsApp id matched. */
  | "WHATSAPP_ID_MATCH"
  /** Only the member's phone number (digits) matched. */
  | "PHONE_MATCH"
  /** Both matched, and both name the same member. The strongest result. */
  | "WHATSAPP_ID_AND_PHONE_MATCH"
  /** The WhatsApp id names one member, the phone digits another. Nobody is credited. */
  | "CONFLICT"
  /** One identifier is shared by several members. Nobody is credited. */
  | "AMBIGUOUS"
  /** No roster member matches: a customer, or a colleague not on the roster. */
  | "UNRESOLVED"
  /** A group, broadcast or channel id — never a person. */
  | "NOT_A_PERSON";

export interface SenderResolution {
  status: SenderMatchStatus;
  /** The member credited with the message. Only ever set when exactly one member matched. */
  memberId: string | null;
  /** True whenever every candidate is a roster member — including CONFLICT and AMBIGUOUS. */
  isRosterMember: boolean;
  /** Every member any identifier pointed at, sorted, for diagnostics. */
  candidateIds: string[];
  /** What the sender id was read as. */
  idKind: WhatsAppIdKind | null;
}

export interface SenderResolver {
  /**
   * @param senderPhone  `Message.senderPhone` (domain stripped) — always available.
   * @param senderJid    `Message.senderJid` (domain kept) — null on rows stored before it existed.
   * @param at           the message's time (ms). Given, a member whose `attributeFrom` is later is
   *                     not a candidate; omitted, `attributeFrom` is ignored.
   */
  resolve(senderPhone: string | null | undefined, senderJid?: string | null, at?: number | null): SenderResolution;
  /**
   * Every stored `senderPhone` value that resolves to exactly this member — for SQL that has to
   * select a member's own messages (`senderPhone = ANY(...)`). An identifier the member shares
   * with somebody else is left out, so a conflict is never counted for either of them.
   */
  identifiersFor(memberId: string): string[];
}

const UNRESOLVED: Omit<SenderResolution, "idKind"> = {
  status: "UNRESOLVED",
  memberId: null,
  isRosterMember: false,
  candidateIds: [],
};

function push(map: Map<string, string[]>, key: string | null, id: string) {
  if (!key) return;
  const list = map.get(key);
  if (!list) map.set(key, [id]);
  else if (!list.includes(id)) list.push(id);
}

export function createSenderResolver(members: readonly RosterIdentity[]): SenderResolver {
  const byWhatsAppId = new Map<string, string[]>();
  const byPhoneDigits = new Map<string, string[]>();
  const attributeFrom = new Map<string, number>();
  for (const member of members) {
    push(byWhatsAppId, whatsappIdKey(member.whatsappId), member.id);
    push(byPhoneDigits, normalizePhoneNumber(member.phoneNumber), member.id);
    const from = member.attributeFrom instanceof Date ? member.attributeFrom.getTime() : member.attributeFrom;
    if (typeof from === "number" && Number.isFinite(from)) attributeFrom.set(member.id, from);
  }

  interface Matches {
    parsed: ReturnType<typeof parseWhatsAppId>;
    idMatches: string[];
    phoneMatches: string[];
  }
  const matchCache = new Map<string, Matches>();
  const decisionCache = new Map<string, SenderResolution>();

  function matchesFor(senderPhone: string | null | undefined, senderJid: string | null | undefined): Matches {
    // The domain-carrying id is the better witness when we have it; the stripped one is the fallback.
    const parsed = parseWhatsAppId(senderJid) ?? parseWhatsAppId(senderPhone);
    if (!parsed || !isPersonKind(parsed.kind)) return { parsed, idMatches: [], phoneMatches: [] };
    const digits = normalizePhoneNumber(parsed.user);
    return { parsed, idMatches: byWhatsAppId.get(parsed.user) ?? [], phoneMatches: digits ? (byPhoneDigits.get(digits) ?? []) : [] };
  }

  function decide({ parsed, idMatches, phoneMatches }: Matches): SenderResolution {
    if (!parsed) return { ...UNRESOLVED, idKind: null };
    if (!isPersonKind(parsed.kind)) {
      return { status: "NOT_A_PERSON", memberId: null, isRosterMember: false, candidateIds: [], idKind: parsed.kind };
    }
    const candidates = [...new Set([...idMatches, ...phoneMatches])].sort();

    if (candidates.length === 0) return { ...UNRESOLVED, idKind: parsed.kind };
    if (candidates.length === 1) {
      const status: SenderMatchStatus =
        idMatches.length && phoneMatches.length
          ? "WHATSAPP_ID_AND_PHONE_MATCH"
          : idMatches.length
            ? "WHATSAPP_ID_MATCH"
            : "PHONE_MATCH";
      return { status, memberId: candidates[0]!, isRosterMember: true, candidateIds: candidates, idKind: parsed.kind };
    }
    // More than one member. If each kind of evidence names exactly one member, and they differ,
    // the two kinds disagree; otherwise one identifier is simply shared.
    const status: SenderMatchStatus = idMatches.length === 1 && phoneMatches.length === 1 ? "CONFLICT" : "AMBIGUOUS";
    return { status, memberId: null, isRosterMember: true, candidateIds: candidates, idKind: parsed.kind };
  }

  function resolve(senderPhone: string | null | undefined, senderJid?: string | null, at?: number | null): SenderResolution {
    const key = `${senderPhone ?? ""}\u0000${senderJid ?? ""}`;
    let matches = matchCache.get(key);
    if (!matches) {
      matches = matchesFor(senderPhone, senderJid);
      matchCache.set(key, matches);
    }
    // Before a member's attribute-from date, they are not a candidate at all: the decision is taken
    // on the members who were. Rarely needed, so never cached (one entry per message time).
    if (typeof at === "number" && attributeFrom.size > 0) {
      const counts = (id: string) => (attributeFrom.get(id) ?? -Infinity) <= at;
      if (![...matches.idMatches, ...matches.phoneMatches].every(counts)) {
        return decide({ parsed: matches.parsed, idMatches: matches.idMatches.filter(counts), phoneMatches: matches.phoneMatches.filter(counts) });
      }
    }
    let hit = decisionCache.get(key);
    if (!hit) {
      hit = decide(matches);
      decisionCache.set(key, hit);
    }
    return hit;
  }

  const byId = new Map(members.map((member) => [member.id, member]));
  function identifiersFor(memberId: string): string[] {
    const member = byId.get(memberId);
    if (!member) return [];
    // The raw typed number too: a stored sender is normally digits-only, but rows written by older
    // code (and test fixtures) can hold the number exactly as it was typed.
    const candidates = [whatsappIdKey(member.whatsappId), member.phoneNumber.trim(), normalizePhoneNumber(member.phoneNumber)];
    return [...new Set(candidates.filter((value): value is string => Boolean(value)))].filter(
      (value) => resolve(value).memberId === memberId,
    );
  }

  return { resolve, identifiersFor };
}

/** Plain-language reading of a status, for diagnostics screens and reconciliation output. */
export const SENDER_MATCH_LABELS: Record<SenderMatchStatus, string> = {
  WHATSAPP_ID_MATCH: "Matched by WhatsApp ID",
  PHONE_MATCH: "Matched by phone number",
  WHATSAPP_ID_AND_PHONE_MATCH: "Matched by WhatsApp ID and phone number",
  CONFLICT: "WhatsApp ID and phone number point to different team members",
  AMBIGUOUS: "Shared by more than one team member",
  UNRESOLVED: "Not on the team roster",
  NOT_A_PERSON: "Not a person (group or broadcast id)",
};

// ---------------------------------------------------------------------------------------------
// Message identity
// ---------------------------------------------------------------------------------------------

/**
 * The parts of a stored `Message.whatsappMessageId` (OpenWA's serialised key):
 * `${fromMe}_${chat}_${keyId}` for a one-to-one message, plus `_${participant}` in a group.
 * Null for an id that is not in that shape (test fixtures, a future provider).
 */
export function parseMessageKey(
  whatsappMessageId: string,
): { fromMe: boolean; chat: string; keyId: string; participant: string | null } | null {
  const parts = String(whatsappMessageId ?? "").split("_");
  if (parts.length < 3 || (parts[0] !== "true" && parts[0] !== "false")) return null;
  const [fromMe, chat, keyId, ...rest] = parts;
  if (!chat || !keyId || !chat.includes("@")) return null;
  const participant = rest.length ? rest.join("_") : null;
  return { fromMe: fromMe === "true", chat, keyId, participant: participant && participant.includes("@") ? participant : null };
}

/**
 * ONE logical WhatsApp message, whichever of our accounts stored it.
 *
 * `whatsappMessageId` is not that: it begins with `true_` on the account that SENT a message and
 * `false_` on every other account that received it, and it carries the author's id, which one
 * account may see as a LID and another as a phone number. Deduplicating on it therefore kept both
 * copies of anything one of our numbers posted in a group another of our numbers is also in —
 * once as the business's reply and once as a "customer" message. The chat plus WhatsApp's own key
 * id is the same on every copy. An id not in OpenWA's shape is its own key, never merged.
 *
 * `MESSAGE_KEY_SQL` (apps/web) is the same rule in SQL; a test pins the two together.
 */
export function logicalMessageKey(chatId: string, whatsappMessageId: string): string {
  const key = parseMessageKey(whatsappMessageId);
  return key ? `${chatId}|${key.keyId}` : `${chatId}|${whatsappMessageId}`;
}

/**
 * The domain-carrying sender id of a row stored before `Message.senderJid` existed, recovered
 * only from what the row itself proves:
 *  - an incoming GROUP message's key names its author (the participant segment);
 *  - an incoming ONE-TO-ONE message's chat is the sender.
 * Null otherwise — an outgoing row was sent by our own account, and a guess is not a backfill.
 */
export function recoverSenderJid(row: {
  whatsappMessageId: string;
  chatId: string;
  direction: "INCOMING" | "OUTGOING" | "SYSTEM";
}): string | null {
  if (row.direction !== "INCOMING") return null;
  const chat = parseWhatsAppId(row.chatId);
  if (!chat) return null;
  if (chat.kind === "GROUP") {
    const participant = parseMessageKey(row.whatsappMessageId)?.participant ?? null;
    const parsed = parseWhatsAppId(participant);
    return parsed && (parsed.kind === "PHONE" || parsed.kind === "LID") ? participant : null;
  }
  if (chat.kind === "PHONE" || chat.kind === "LID") return row.chatId;
  return null;
}

/**
 * How to show a sender's number. Only a PHONE id is a number anybody can dial; a LID is shown as
 * an id and never formatted as if it were a phone, and an id whose domain is unknown is not
 * presented as either.
 */
export function describeSenderId(senderPhone: string | null | undefined, senderJid?: string | null): {
  kind: WhatsAppIdKind | null;
  /** "+8801712345678" when the id is a phone number, else null. */
  phone: string | null;
  /** The raw id, for display as "WhatsApp ID". */
  id: string | null;
} {
  const parsed = parseWhatsAppId(senderJid) ?? parseWhatsAppId(senderPhone);
  if (!parsed) return { kind: null, phone: null, id: null };
  const digits = normalizePhoneNumber(parsed.user);
  return {
    kind: parsed.kind,
    phone: parsed.kind === "PHONE" && digits ? `+${digits}` : null,
    id: parsed.user,
  };
}

// ---------------------------------------------------------------------------------------------
// One logical message, several stored copies
// ---------------------------------------------------------------------------------------------

/** What one stored copy of a message says about who sent it. */
export interface StoredCopyIdentity {
  senderPhone: string | null;
  senderJid: string | null;
  /** `Message.isFromTeamMember` as that copy was stamped when it arrived. */
  fromTeam: boolean;
}

/** Who sent a logical message, decided over every copy of it we stored. */
export interface CopiesAttribution {
  /** The member credited, or null. Only ever set when every copy that names a member names this one. */
  memberId: string | null;
  /** Certainly a colleague (credited or not): the safety reading every report keeps. */
  isStaff: boolean;
  /** How it was decided, for the reliability counts: the strongest copy's match, or CONFLICT. */
  status: SenderMatchStatus;
}

const STATUS_STRENGTH: Record<SenderMatchStatus, number> = {
  WHATSAPP_ID_AND_PHONE_MATCH: 3,
  WHATSAPP_ID_MATCH: 2,
  PHONE_MATCH: 1,
  CONFLICT: 0,
  AMBIGUOUS: 0,
  UNRESOLVED: 0,
  NOT_A_PERSON: 0,
};

/**
 * Who sent a message that two or more of our numbers each stored a copy of.
 *
 * WhatsApp can show one author as a LID to one of our accounts and as a phone number to another, so
 * a member on file with only one of the two matches only one copy. Reports keep ONE copy per logical
 * message, and which one was effectively arbitrary — so whether a colleague's reply was theirs or a
 * "customer" message (opening a wait, and a Missed charged to the group's assignee) depended on row
 * order. Every copy is a witness now:
 *
 *  - copies naming exactly one member, and no copy naming a different one → that member;
 *  - copies naming two different members → staff, credited to nobody (CONFLICT);
 *  - no member named, but a copy is a roster CONFLICT/AMBIGUOUS → staff, credited to nobody;
 *  - otherwise the stored team-member stamp, but only for a sender the roster no longer knows at all
 *    (a deleted member: their history stays staff). A sender the roster still knows, and excludes
 *    only by the member's "count their messages from" date, is a customer at that moment — the stamp
 *    was taken without the date, so it must not override it.
 */
export function attributeAcrossCopies(
  resolver: SenderResolver,
  copies: readonly StoredCopyIdentity[],
  at?: number | null,
): CopiesAttribution {
  const resolved = copies.map((copy) => ({ copy, r: resolver.resolve(copy.senderPhone, copy.senderJid, at) }));
  const memberIds = [...new Set(resolved.map(({ r }) => r.memberId).filter((id): id is string => id !== null))];
  if (memberIds.length === 1) {
    const best = resolved
      .filter(({ r }) => r.memberId === memberIds[0])
      .reduce((a, b) => (STATUS_STRENGTH[b.r.status] > STATUS_STRENGTH[a.r.status] ? b : a));
    return { memberId: memberIds[0]!, isStaff: true, status: best.r.status };
  }
  if (memberIds.length > 1) return { memberId: null, isStaff: true, status: "CONFLICT" };
  const roster = resolved.find(({ r }) => r.isRosterMember);
  if (roster) return { memberId: null, isStaff: true, status: roster.r.status };
  const stamped = resolved.some(({ copy }) => copy.fromTeam);
  const knownWithoutDate = typeof at === "number" && resolved.some(({ copy }) => resolver.resolve(copy.senderPhone, copy.senderJid).isRosterMember);
  return { memberId: null, isStaff: stamped && !knownWithoutDate, status: resolved[0]?.r.status ?? "UNRESOLVED" };
}

/** Separator between a stored copy's fields in the SQL `copies` column (`storedCopiesSql`). */
export const COPY_FIELD_SEPARATOR = "\u001f";

/** Reads the `copies` column the report loaders select: one "phone␟jid␟0|1" string per incoming copy. */
export function parseStoredCopies(values: readonly string[] | null | undefined): StoredCopyIdentity[] {
  return (values ?? []).map((value) => {
    const [phone, jid, flag] = value.split(COPY_FIELD_SEPARATOR);
    return { senderPhone: phone || null, senderJid: jid || null, fromTeam: flag === "1" };
  });
}

/**
 * Whether a sender is one of OUR numbers: its id is in `ownIds` (the project's account phone digits
 * and the ids our accounts are seen sending from in groups — the worker's `ownAccounts.ts` evidence).
 * A copy one of our numbers stored as INCOMING before that check existed is the business's message,
 * never a customer's.
 */
export function isOwnSender(ownIds: ReadonlySet<string>, senderPhone: string | null, senderJid: string | null): boolean {
  const parsed = parseWhatsAppId(senderJid) ?? parseWhatsAppId(senderPhone);
  if (!parsed || !isPersonKind(parsed.kind)) return false;
  if (ownIds.has(parsed.user)) return true;
  const digits = normalizePhoneNumber(parsed.user);
  return digits !== null && ownIds.has(digits);
}

// ---------------------------------------------------------------------------------------------
// The report classifier (moved here from apps/web `server/messageIdentity.ts`, unified reporting WP5,
// body unchanged apart from the optional `parsedCopies`). It has no Prisma dependency, and the identity
// preview must run it with two different rosters, so it lives with the rest of the identity rule.

/** What a report loader selects about one kept message, for `ReportIdentity.classify`. */
export interface ReportSenderRow {
  direction: string;
  sender: string;
  senderJid: string | null;
  fromTeam: boolean;
  /** `storedCopiesSql`; null/absent = this row is the only witness. */
  copies?: string[] | null;
  /** The same witnesses already parsed; used instead of `copies` when present and not empty. */
  parsedCopies?: readonly StoredCopyIdentity[] | null;
  /** From `outboundByKeyJoin`: true when the message echoes one of our sends. */
  obMatched?: boolean | null;
  actionType: string | null;
  ruleId: string | null;
  createdById: string | null;
}

export interface ReportSenderDecision {
  kind: "MEMBER" | "CUSTOMER" | "BUSINESS";
  memberId: string | null;
  actor: IntelActor;
  /** How a person was matched (null for the business's own messages). */
  status: SenderMatchStatus | null;
}

export interface ReportIdentity {
  resolver: SenderResolver;
  classify(row: ReportSenderRow, at: number): ReportSenderDecision;
}

/**
 * Who sent one kept message, the ONE way every report decides it:
 *  1. Our own message — the kept copy is OUTGOING, it echoes one of our sends, or a copy's sender is
 *     one of our numbers → the business's. Who: the send it echoes (`outgoingActorFor`). A reply a
 *     dashboard user typed is credited to the team member linked to that login (Team Members → login
 *     link), because it is that person's work; unlinked, it stays the business number's.
 *  2. Otherwise every stored copy is a witness (`attributeAcrossCopies`).
 */
export function createReportClassifier(
  resolver: SenderResolver,
  ownIds: ReadonlySet<string>,
  memberByUserId: ReadonlyMap<string, string | { id: string; attributeFrom?: Date | number | null }>,
): ReportIdentity {
  const linked = (userId: string, at: number): string | null => {
    const entry = memberByUserId.get(userId);
    if (!entry) return null;
    if (typeof entry === "string") return entry;
    // The member's "count their messages from" date applies to replies from their login too.
    const from = entry.attributeFrom instanceof Date ? entry.attributeFrom.getTime() : entry.attributeFrom;
    return typeof from === "number" && at < from ? null : entry.id;
  };
  return {
    resolver,
    classify(row, at) {
      const copies = row.parsedCopies?.length
        ? row.parsedCopies
        : row.copies?.length
          ? parseStoredCopies(row.copies)
          : [{ senderPhone: row.sender, senderJid: row.senderJid, fromTeam: row.fromTeam }];
      const ours =
        row.direction === "OUTGOING" ||
        Boolean(row.obMatched) ||
        isOwnSender(ownIds, row.sender, row.senderJid) ||
        copies.some((copy) => isOwnSender(ownIds, copy.senderPhone, copy.senderJid));
      if (ours) {
        const actor: IntelActor = row.obMatched || row.direction === "OUTGOING" ? outgoingActorFor(row.actionType, row.ruleId) : "BUSINESS_PHONE";
        const operatorMember = actor === "OPERATOR" && row.createdById ? linked(row.createdById, at) : null;
        return operatorMember
          ? { kind: "MEMBER", memberId: operatorMember, actor, status: null }
          : { kind: "BUSINESS", memberId: null, actor, status: null };
      }
      const decided = attributeAcrossCopies(resolver, copies, at);
      return {
        kind: decided.isStaff ? "MEMBER" : "CUSTOMER",
        memberId: decided.memberId,
        actor: decided.memberId ? "MEMBER" : decided.isStaff ? "MEMBER_UNMAPPED" : "CUSTOMER",
        status: decided.status,
      };
    },
  };
}
