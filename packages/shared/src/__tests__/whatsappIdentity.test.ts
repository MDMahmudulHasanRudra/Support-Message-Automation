import { describe, expect, it } from "vitest";
import {
  attributeAcrossCopies,
  COPY_FIELD_SEPARATOR,
  createReportClassifier,
  createSenderResolver,
  describeSenderId,
  isOwnSender,
  logicalMessageKey,
  parseMessageKey,
  parseStoredCopies,
  parseWhatsAppId,
  recoverSenderJid,
  type ReportSenderDecision,
  type ReportSenderRow,
  type RosterIdentity,
  type SenderResolver,
} from "../whatsappIdentity.js";
import { outgoingActorFor, type IntelActor } from "../intelligence/model.js";

/**
 * One rule decides which roster member sent a message (WHATSAPP_IDENTITY.md). These pin it,
 * including the two outcomes the old copies got silently wrong: a WhatsApp id and a phone number
 * naming DIFFERENT people, and one identifier shared by two people. Both used to credit whichever
 * member happened to come first.
 */

const RAKIB: RosterIdentity = { id: "m-rakib", phoneNumber: "+8801711000001", whatsappId: "161679983804516" };
const BIPUL: RosterIdentity = { id: "m-bipul", phoneNumber: "+880 1711-000002", whatsappId: null };
const SARA_UK: RosterIdentity = { id: "m-sara", phoneNumber: "+44 7700 900123", whatsappId: null };

describe("parseWhatsAppId", () => {
  it("reads each domain WhatsApp uses", () => {
    expect(parseWhatsAppId("8801711000001@c.us")).toEqual({ kind: "PHONE", user: "8801711000001" });
    expect(parseWhatsAppId("8801711000001@s.whatsapp.net")).toEqual({ kind: "PHONE", user: "8801711000001" });
    expect(parseWhatsAppId("161679983804516@lid")).toEqual({ kind: "LID", user: "161679983804516" });
    expect(parseWhatsAppId("120363000000000000@g.us")?.kind).toBe("GROUP");
    expect(parseWhatsAppId("status@broadcast")?.kind).toBe("BROADCAST");
    expect(parseWhatsAppId("120363000000000000@newsletter")?.kind).toBe("NEWSLETTER");
  });

  it("drops a multi-device suffix", () => {
    expect(parseWhatsAppId("8801711000001:12@s.whatsapp.net")).toEqual({ kind: "PHONE", user: "8801711000001" });
  });

  it("calls a bare id UNKNOWN rather than guessing it is a phone", () => {
    expect(parseWhatsAppId("161679983804516")).toEqual({ kind: "UNKNOWN", user: "161679983804516" });
  });

  it("returns null for nothing", () => {
    for (const junk of ["", "   ", null, undefined, "@c.us"]) expect(parseWhatsAppId(junk)).toBeNull();
  });
});

describe("createSenderResolver — matches", () => {
  const resolver = createSenderResolver([RAKIB, BIPUL, SARA_UK]);

  it("matches an exact WhatsApp id (a LID)", () => {
    expect(resolver.resolve("161679983804516", "161679983804516@lid")).toMatchObject({
      status: "WHATSAPP_ID_MATCH",
      memberId: "m-rakib",
      isRosterMember: true,
      idKind: "LID",
    });
  });

  it("matches a normalized phone number however it was typed", () => {
    expect(resolver.resolve("8801711000002", "8801711000002@c.us")).toMatchObject({ status: "PHONE_MATCH", memberId: "m-bipul" });
    expect(resolver.resolve("+8801711000002")).toMatchObject({ status: "PHONE_MATCH", memberId: "m-bipul" });
  });

  it("matches an international number", () => {
    expect(resolver.resolve("447700900123", "447700900123@c.us")).toMatchObject({ memberId: "m-sara" });
  });

  it("records both kinds of evidence when they agree", () => {
    const both = createSenderResolver([{ id: "m-1", phoneNumber: "8801711000009", whatsappId: "8801711000009" }]);
    expect(both.resolve("8801711000009")).toMatchObject({ status: "WHATSAPP_ID_AND_PHONE_MATCH", memberId: "m-1" });
  });

  it("works for legacy rows that have no senderJid", () => {
    expect(resolver.resolve("161679983804516", null)).toMatchObject({ memberId: "m-rakib", idKind: "UNKNOWN" });
  });

  it("compares a WhatsApp id exactly, never by digits", () => {
    expect(resolver.resolve("+16167998380 4516").memberId).toBeNull();
  });
});

describe("createSenderResolver — never misattributes", () => {
  it("does not match an unknown id or a different number", () => {
    const resolver = createSenderResolver([RAKIB, BIPUL]);
    expect(resolver.resolve("222200183419092", "222200183419092@lid")).toMatchObject({ status: "UNRESOLVED", memberId: null, isRosterMember: false });
    expect(resolver.resolve("8801711000099")).toMatchObject({ status: "UNRESOLVED", memberId: null });
  });

  it("does not match a number that only shares a suffix", () => {
    expect(createSenderResolver([BIPUL]).resolve("4401711000002").memberId).toBeNull();
  });

  it("never matches a group id, even one whose digits equal a member's number", () => {
    const member = { id: "m-1", phoneNumber: "8801711000001", whatsappId: null };
    const result = createSenderResolver([member]).resolve("8801711000001", "8801711000001@g.us");
    expect(result).toMatchObject({ status: "NOT_A_PERSON", memberId: null, isRosterMember: false });
    expect(createSenderResolver([member]).resolve("8801711000001@g.us").status).toBe("NOT_A_PERSON");
  });

  it("reports CONFLICT when the WhatsApp id names one member and the phone another", () => {
    // Rakib's WhatsApp id was typed into Bipul's phone field.
    const bipulWithRakibsId = { id: "m-bipul", phoneNumber: "161679983804516", whatsappId: null };
    const result = createSenderResolver([RAKIB, bipulWithRakibsId]).resolve("161679983804516");
    expect(result).toMatchObject({ status: "CONFLICT", memberId: null, isRosterMember: true });
    expect(result.candidateIds).toEqual(["m-bipul", "m-rakib"]);
  });

  it("gives the same CONFLICT whatever order the roster arrives in", () => {
    const bipulWithRakibsId = { id: "m-bipul", phoneNumber: "161679983804516", whatsappId: null };
    const a = createSenderResolver([RAKIB, bipulWithRakibsId]).resolve("161679983804516");
    const b = createSenderResolver([bipulWithRakibsId, RAKIB]).resolve("161679983804516");
    expect(a).toEqual(b);
  });

  it("reports AMBIGUOUS when two members share one number (a duplicate record)", () => {
    const dup = { id: "m-bipul-old", phoneNumber: "8801711000002", whatsappId: null };
    expect(createSenderResolver([BIPUL, dup]).resolve("8801711000002")).toMatchObject({
      status: "AMBIGUOUS",
      memberId: null,
      isRosterMember: true,
      candidateIds: ["m-bipul", "m-bipul-old"],
    });
  });

  it("reports AMBIGUOUS when two members share one WhatsApp id", () => {
    const dup = { id: "m-other", phoneNumber: "8801711000077", whatsappId: "161679983804516" };
    expect(createSenderResolver([RAKIB, dup]).resolve("161679983804516").status).toBe("AMBIGUOUS");
  });

  it("returns UNRESOLVED for a missing sender", () => {
    const resolver = createSenderResolver([RAKIB]);
    expect(resolver.resolve(null).status).toBe("UNRESOLVED");
    expect(resolver.resolve("", "").status).toBe("UNRESOLVED");
  });

  it("follows an identity change: the old number stops matching, the new one starts", () => {
    const before = createSenderResolver([{ id: "m-1", phoneNumber: "8801711000001", whatsappId: null }]);
    const after = createSenderResolver([{ id: "m-1", phoneNumber: "8801999000001", whatsappId: null }]);
    expect(before.resolve("8801711000001").memberId).toBe("m-1");
    expect(after.resolve("8801711000001").memberId).toBeNull();
    expect(after.resolve("8801999000001").memberId).toBe("m-1");
  });

  it("ignores a member with no usable identifiers rather than matching everything", () => {
    const resolver = createSenderResolver([{ id: "m-1", phoneNumber: "n/a", whatsappId: "" }]);
    expect(resolver.resolve("").memberId).toBeNull();
    expect(resolver.resolve("8801711000001").memberId).toBeNull();
  });
});

describe("identifiersFor", () => {
  it("lists every stored form that resolves to the member", () => {
    const resolver = createSenderResolver([RAKIB, BIPUL]);
    expect(resolver.identifiersFor("m-rakib").sort()).toEqual(["+8801711000001", "161679983804516", "8801711000001"]);
    expect(resolver.identifiersFor("m-bipul").sort()).toEqual(["+880 1711-000002", "8801711000002"]);
  });

  it("leaves out an identifier shared with someone else, so neither is counted", () => {
    const bipulWithRakibsId = { id: "m-bipul", phoneNumber: "161679983804516", whatsappId: null };
    const resolver = createSenderResolver([RAKIB, bipulWithRakibsId]);
    expect(resolver.identifiersFor("m-rakib").sort()).toEqual(["+8801711000001", "8801711000001"]);
    expect(resolver.identifiersFor("m-bipul")).toEqual([]);
  });

  it("is empty for an unknown member", () => {
    expect(createSenderResolver([RAKIB]).identifiersFor("nobody")).toEqual([]);
  });
});

describe("message identity", () => {
  const group = "120363000000000001@g.us";

  it("parses OpenWA's serialised key", () => {
    expect(parseMessageKey(`false_${group}_3EB0ABC_161679983804516@lid`)).toEqual({
      fromMe: false,
      chat: group,
      keyId: "3EB0ABC",
      participant: "161679983804516@lid",
    });
    expect(parseMessageKey("true_8801711000001@c.us_3EB0ABC")).toMatchObject({ fromMe: true, participant: null });
    expect(parseMessageKey("wamid-123")).toBeNull();
  });

  it("gives every account's copy of one group message the same logical key", () => {
    const senderCopy = logicalMessageKey(group, `true_${group}_3EB0ABC_8801711000001@c.us`);
    const receiverCopy = logicalMessageKey(group, `false_${group}_3EB0ABC_161679983804516@lid`);
    expect(senderCopy).toBe(receiverCopy);
  });

  it("keeps two different messages apart, even with identical text", () => {
    expect(logicalMessageKey(group, `false_${group}_AAA_1@lid`)).not.toBe(logicalMessageKey(group, `false_${group}_BBB_1@lid`));
  });

  it("never merges ids that are not in OpenWA's shape", () => {
    expect(logicalMessageKey(group, "wamid-1")).not.toBe(logicalMessageKey(group, "wamid-2"));
  });
});

describe("recoverSenderJid", () => {
  const group = "120363000000000001@g.us";

  it("recovers a group author from the message key", () => {
    expect(recoverSenderJid({ whatsappMessageId: `false_${group}_ABC_161679983804516@lid`, chatId: group, direction: "INCOMING" })).toBe(
      "161679983804516@lid",
    );
  });

  it("recovers a one-to-one sender from the chat", () => {
    expect(recoverSenderJid({ whatsappMessageId: "false_8801711000001@c.us_ABC", chatId: "8801711000001@c.us", direction: "INCOMING" })).toBe(
      "8801711000001@c.us",
    );
  });

  it("does not guess for outgoing rows or keys without an author", () => {
    expect(recoverSenderJid({ whatsappMessageId: `true_${group}_ABC`, chatId: group, direction: "OUTGOING" })).toBeNull();
    expect(recoverSenderJid({ whatsappMessageId: `false_${group}_ABC`, chatId: group, direction: "INCOMING" })).toBeNull();
    expect(recoverSenderJid({ whatsappMessageId: "wamid-1", chatId: group, direction: "INCOMING" })).toBeNull();
  });
});

describe("describeSenderId", () => {
  it("shows a phone only for a phone id", () => {
    expect(describeSenderId("8801711000001", "8801711000001@c.us")).toEqual({ kind: "PHONE", phone: "+8801711000001", id: "8801711000001" });
    expect(describeSenderId("161679983804516", "161679983804516@lid")).toEqual({ kind: "LID", phone: null, id: "161679983804516" });
    expect(describeSenderId("8801711000001", null).phone).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// createReportClassifier moved from apps/web (unified reporting WP5). The reference below is the
// HEAD body copied verbatim and frozen: the shared export must decide every row exactly as it did.

const referenceClassifier = (
  resolver: SenderResolver,
  ownIds: ReadonlySet<string>,
  memberByUserId: ReadonlyMap<string, string | { id: string; attributeFrom?: Date | number | null }>,
) => {
  const linked = (userId: string, at: number): string | null => {
    const entry = memberByUserId.get(userId);
    if (!entry) return null;
    if (typeof entry === "string") return entry;
    const from = entry.attributeFrom instanceof Date ? entry.attributeFrom.getTime() : entry.attributeFrom;
    return typeof from === "number" && at < from ? null : entry.id;
  };
  return (row: ReportSenderRow, at: number): ReportSenderDecision => {
    const copies = row.copies?.length ? parseStoredCopies(row.copies) : [{ senderPhone: row.sender, senderJid: row.senderJid, fromTeam: row.fromTeam }];
    const ours =
      row.direction === "OUTGOING" ||
      Boolean(row.obMatched) ||
      isOwnSender(ownIds, row.sender, row.senderJid) ||
      copies.some((copy) => isOwnSender(ownIds, copy.senderPhone, copy.senderJid));
    if (ours) {
      const actor: IntelActor = row.obMatched || row.direction === "OUTGOING" ? outgoingActorFor(row.actionType, row.ruleId) : "BUSINESS_PHONE";
      const operatorMember = actor === "OPERATOR" && row.createdById ? linked(row.createdById, at) : null;
      return operatorMember ? { kind: "MEMBER", memberId: operatorMember, actor, status: null } : { kind: "BUSINESS", memberId: null, actor, status: null };
    }
    const decided = attributeAcrossCopies(resolver, copies, at);
    return {
      kind: decided.isStaff ? "MEMBER" : "CUSTOMER",
      memberId: decided.memberId,
      actor: decided.memberId ? "MEMBER" : decided.isStaff ? "MEMBER_UNMAPPED" : "CUSTOMER",
      status: decided.status,
    };
  };
};

describe("createReportClassifier", () => {
  const SEP = COPY_FIELD_SEPARATOR;
  const copy = (phone: string, jid: string | null, team = false) => [phone, jid ?? "", team ? "1" : "0"].join(SEP);
  const roster: RosterIdentity[] = [
    { id: "rina", phoneNumber: "+8801000000101", whatsappId: "200000000101@lid" },
    { id: "omar", phoneNumber: "+200000000101", whatsappId: null },
    { id: "nadia", phoneNumber: "+8801000000103", whatsappId: null, attributeFrom: Date.UTC(2026, 9, 10) },
  ];
  const own = new Set(["8801000000900", "199900000001"]);
  const logins = new Map<string, string | { id: string; attributeFrom?: Date | number | null }>([
    ["user-linked", "rina"],
    ["user-dated", { id: "nadia", attributeFrom: Date.UTC(2026, 9, 10) }],
  ]);
  const resolver = createSenderResolver(roster);
  const shared = createReportClassifier(resolver, own, logins);
  const reference = referenceClassifier(resolver, own, logins);
  const AFTER = Date.UTC(2026, 9, 15);
  const BEFORE = Date.UTC(2026, 9, 5);

  const row = (over: Partial<ReportSenderRow>): ReportSenderRow => ({
    direction: "INCOMING",
    sender: "100000000001",
    senderJid: "100000000001@lid",
    fromTeam: false,
    actionType: null,
    ruleId: null,
    createdById: null,
    ...over,
  });

  it("decides the documented cases", () => {
    expect(shared.classify(row({}), AFTER)).toEqual({ kind: "CUSTOMER", memberId: null, actor: "CUSTOMER", status: "UNRESOLVED" });
    expect(shared.classify(row({ sender: "8801000000101", senderJid: "8801000000101@c.us" }), AFTER)).toMatchObject({ kind: "MEMBER", memberId: "rina", actor: "MEMBER" });
    // Rina's WhatsApp id is also Omar's number: staff, credited to nobody.
    expect(shared.classify(row({ sender: "200000000101", senderJid: "200000000101@lid" }), AFTER)).toEqual({ kind: "MEMBER", memberId: null, actor: "MEMBER_UNMAPPED", status: "CONFLICT" });
    // Our own post stored as INCOMING by another of our numbers is the business's.
    expect(shared.classify(row({ sender: "8801000000900", senderJid: "8801000000900@c.us" }), AFTER)).toEqual({ kind: "BUSINESS", memberId: null, actor: "BUSINESS_PHONE", status: null });
    expect(shared.classify(row({ direction: "OUTGOING", obMatched: true, actionType: "AUTO_REPLY" }), AFTER).actor).toBe("AI");
    expect(shared.classify(row({ direction: "OUTGOING", obMatched: true, actionType: "AUTO_REPLY", ruleId: "r1" }), AFTER).actor).toBe("RULE");
    expect(shared.classify(row({ direction: "OUTGOING", obMatched: true, actionType: "GROUP_BROADCAST" }), AFTER).actor).toBe("BROADCAST");
    // A dashboard reply is the linked member's work; an unlinked login's stays the business's; a dated link honours attributeFrom.
    expect(shared.classify(row({ direction: "OUTGOING", obMatched: true, actionType: "MANUAL_REPLY", createdById: "user-linked" }), AFTER)).toEqual({ kind: "MEMBER", memberId: "rina", actor: "OPERATOR", status: null });
    expect(shared.classify(row({ direction: "OUTGOING", obMatched: true, actionType: "MANUAL_REPLY", createdById: "nobody" }), AFTER)).toEqual({ kind: "BUSINESS", memberId: null, actor: "OPERATOR", status: null });
    expect(shared.classify(row({ direction: "OUTGOING", obMatched: true, actionType: "MANUAL_REPLY", createdById: "user-dated" }), BEFORE).memberId).toBeNull();
    expect(shared.classify(row({ direction: "OUTGOING", obMatched: true, actionType: "MANUAL_REPLY", createdById: "user-dated" }), AFTER).memberId).toBe("nadia");
    // A copy another of our numbers stored names one of our own numbers: the business's, whatever the kept row says.
    expect(
      shared.classify(row({ copies: [copy("100000000001", "100000000001@lid"), copy("8801000000900", "8801000000900@c.us")] }), AFTER),
    ).toEqual({ kind: "BUSINESS", memberId: null, actor: "BUSINESS_PHONE", status: null });
    // An OUTGOING row that echoes no send is somebody on the business phone.
    expect(shared.classify(row({ direction: "OUTGOING" }), AFTER).actor).toBe("BUSINESS_PHONE");
  });

  it("hears every stored copy; parsedCopies is the same witnesses already parsed", () => {
    // One account saw only the colleague's private WhatsApp id, another saw their number.
    const copies = [copy("8801000000101", "8801000000101@c.us"), copy("999000000001", "999000000001@lid")];
    expect(shared.classify(row({ sender: "999000000001", senderJid: "999000000001@lid", copies }), AFTER)).toMatchObject({ memberId: "rina", actor: "MEMBER" });
    expect(shared.classify(row({ sender: "999000000001", senderJid: "999000000001@lid" }), AFTER).memberId).toBeNull();
    const parsed = parseStoredCopies(copies);
    expect(shared.classify(row({ sender: "999000000001", senderJid: "999000000001@lid", parsedCopies: parsed }), AFTER)).toEqual(
      shared.classify(row({ sender: "999000000001", senderJid: "999000000001@lid", copies }), AFTER),
    );
  });

  it("createReportClassifier moved without change", () => {
    const senders: Array<[string, string | null]> = [
      ["100000000001", "100000000001@lid"],
      ["8801000000101", "8801000000101@c.us"],
      ["200000000101", "200000000101@lid"],
      ["8801000000103", "8801000000103@c.us"],
      ["8801000000900", "8801000000900@c.us"],
      ["199900000001", "199900000001@lid"],
      ["120000000000000001", "120000000000000001@g.us"],
    ];
    const copySets: Array<string[] | null> = [
      null,
      [],
      [copy("8801000000101", null), copy("100000000001", "100000000001@lid")],
      [copy("8801000000103", "8801000000103@c.us", true)],
      [copy("777", null, true)],
      // The kept row looks like a customer, but another of our numbers stored the same message as its own post.
      [copy("100000000001", "100000000001@lid"), copy("8801000000900", "8801000000900@c.us")],
    ];
    let compared = 0;
    for (const direction of ["INCOMING", "OUTGOING"]) {
      for (const [sender, senderJid] of senders) {
        for (const copies of copySets) {
          for (const obMatched of [false, true, null]) {
            for (const [actionType, ruleId] of [[null, null], ["AUTO_REPLY", null], ["AUTO_REPLY", "r1"], ["MANUAL_REPLY", null], ["GROUP_BROADCAST", null]] as const) {
              for (const createdById of [null, "user-linked", "user-dated", "unknown"]) {
                for (const fromTeam of [false, true]) {
                  for (const at of [BEFORE, AFTER]) {
                    const input = row({ direction, sender, senderJid, copies, obMatched, actionType, ruleId, createdById, fromTeam });
                    expect(shared.classify(input, at)).toEqual(reference(input, at));
                    compared += 1;
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(5000);
  });
});
