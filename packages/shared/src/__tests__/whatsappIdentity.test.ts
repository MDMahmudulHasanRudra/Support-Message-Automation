import { describe, expect, it } from "vitest";
import {
  createSenderResolver,
  describeSenderId,
  logicalMessageKey,
  parseMessageKey,
  parseWhatsAppId,
  recoverSenderJid,
  type RosterIdentity,
} from "../whatsappIdentity.js";

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
