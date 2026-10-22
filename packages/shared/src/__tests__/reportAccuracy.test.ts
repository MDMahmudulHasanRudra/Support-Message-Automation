import { describe, expect, it } from "vitest";
import { normalizePhoneNumber } from "../groupParticipantAdd.js";
import { attributeAcrossCopies, createSenderResolver, isOwnSender, parseStoredCopies, COPY_FIELD_SEPARATOR } from "../whatsappIdentity.js";
import { computeTeamReport, type ReportMessage } from "../teamReport.js";

/** Report accuracy audit (19 Oct 2026), the pure rules. */

describe("a local Bangladeshi number", () => {
  it("gets its country code, so it matches what WhatsApp delivers", () => {
    expect(normalizePhoneNumber("01712345678")).toBe("8801712345678");
    expect(normalizePhoneNumber("017-1234-5678")).toBe("8801712345678");
    expect(normalizePhoneNumber("+8801712345678")).toBe("8801712345678");
  });

  it("leaves every other number, and every LID, exactly as it was", () => {
    expect(normalizePhoneNumber("447700900123")).toBe("447700900123");
    expect(normalizePhoneNumber("161679983804516")).toBe("161679983804516");
    expect(normalizePhoneNumber("0171234567")).toBe("0171234567");
  });

  it("is matched by the identity rule against WhatsApp's international form", () => {
    const resolver = createSenderResolver([{ id: "lima", phoneNumber: "01712345678", whatsappId: null }]);
    expect(resolver.resolve("8801712345678", "8801712345678@c.us")).toMatchObject({ memberId: "lima", status: "PHONE_MATCH" });
    expect(resolver.identifiersFor("lima")).toContain("8801712345678");
  });
});

describe("one message, several stored copies", () => {
  const resolver = createSenderResolver([
    { id: "nadia", phoneNumber: "+8801711000001", whatsappId: null },
    { id: "rakib", phoneNumber: "+8801711000002", whatsappId: "161679983804516" },
    { id: "karim", phoneNumber: "+8801711000003", whatsappId: null, attributeFrom: Date.UTC(2025, 5, 1) },
  ]);
  const copy = (senderPhone: string, senderJid: string | null, fromTeam = false) => ({ senderPhone, senderJid, fromTeam });

  it("credits the member any copy identifies, whichever copy comes first", () => {
    const lidCopy = copy("199999999999999", "199999999999999@lid");
    const phoneCopy = copy("8801711000001", "8801711000001@c.us");
    expect(attributeAcrossCopies(resolver, [lidCopy, phoneCopy])).toMatchObject({ memberId: "nadia", isStaff: true, status: "PHONE_MATCH" });
    expect(attributeAcrossCopies(resolver, [phoneCopy, lidCopy])).toMatchObject({ memberId: "nadia", isStaff: true });
  });

  it("credits nobody, but keeps it staff, when two copies name two different members", () => {
    const decided = attributeAcrossCopies(resolver, [copy("8801711000001", "8801711000001@c.us"), copy("161679983804516", "161679983804516@lid")]);
    expect(decided).toMatchObject({ memberId: null, isStaff: true, status: "CONFLICT" });
  });

  it("keeps a sender stamped staff and no longer on the roster as staff (a deleted member's history)", () => {
    expect(attributeAcrossCopies(resolver, [copy("8801799999999", null, true)], Date.UTC(2025, 6, 1))).toMatchObject({ memberId: null, isStaff: true });
  });

  it("does NOT let the stamp override a member's 'count their messages from' date", () => {
    const before = Date.UTC(2025, 4, 1);
    expect(attributeAcrossCopies(resolver, [copy("8801711000003", null, true)], before)).toMatchObject({ memberId: null, isStaff: false });
    expect(attributeAcrossCopies(resolver, [copy("8801711000003", null, true)], Date.UTC(2025, 6, 1))).toMatchObject({ memberId: "karim" });
  });

  it("is a customer when no copy names anybody and none was stamped", () => {
    expect(attributeAcrossCopies(resolver, [copy("8801788888888", null)])).toMatchObject({ memberId: null, isStaff: false, status: "UNRESOLVED" });
  });

  it("reads the copies column the loaders select", () => {
    const s = COPY_FIELD_SEPARATOR;
    expect(parseStoredCopies([`8801711000001${s}8801711000001@c.us${s}1`, `1999${s}${s}0`])).toEqual([
      { senderPhone: "8801711000001", senderJid: "8801711000001@c.us", fromTeam: true },
      { senderPhone: "1999", senderJid: null, fromTeam: false },
    ]);
    expect(parseStoredCopies(null)).toEqual([]);
  });
});

describe("our own numbers", () => {
  const ours = new Set(["8801711000009", "177777777777777"]);
  it("recognises our account's number in any written form, and our LID", () => {
    expect(isOwnSender(ours, "8801711000009", "8801711000009@c.us")).toBe(true);
    expect(isOwnSender(ours, "177777777777777", "177777777777777@lid")).toBe(true);
    expect(isOwnSender(ours, "01711000009", null)).toBe(true);
  });
  it("never reads a customer or a group id as ours", () => {
    expect(isOwnSender(ours, "8801711000008", null)).toBe(false);
    expect(isOwnSender(ours, "8801711000009", "8801711000009@g.us")).toBe(false);
  });
});

describe("Team Report scope and unattributed staff", () => {
  const DAY = Date.UTC(2025, 4, 14) - 6 * 3_600_000;
  const at = (minutes: number) => DAY + 3 * 3_600_000 + minutes * 60_000;
  const base = {
    rangeStart: DAY,
    rangeEnd: DAY + 86_400_000,
    now: DAY + 2 * 86_400_000,
    idleGapMs: 2 * 3_600_000,
    missedAfterMs: () => 30 * 60_000,
    granularity: "day" as const,
  };
  const messages: ReportMessage[] = [
    // Group G1: assigned to Rakib, never answered.
    { groupKey: "G1", ts: at(0), kind: "CUSTOMER", memberId: null },
    // Group G2: Rakib answers.
    { groupKey: "G2", ts: at(10), kind: "CUSTOMER", memberId: null },
    { groupKey: "G2", ts: at(12), kind: "MEMBER", memberId: "rakib" },
    // Group G3: a colleague nobody could identify answers.
    { groupKey: "G3", ts: at(20), kind: "CUSTOMER", memberId: null },
    { groupKey: "G3", ts: at(21), kind: "MEMBER", memberId: null },
  ];
  const assigned = (g: string) => (g === "G1" ? "rakib" : null);

  it("counts the waits and customers of a group the member was assigned to, beside the Missed charged for it", () => {
    const result = computeTeamReport(messages, { ...base, assignedMemberFor: assigned, memberId: "rakib" });
    expect(result.summary.missed).toBe(1);
    expect(result.summary.waits).toBe(2);
    expect(result.summary.customerMessages).toBe(2);
    expect(result.summary.groupsSupported).toBe(1);
    expect(result.groups.map((g) => g.groupKey).sort()).toEqual(["G1", "G2"]);
  });

  it("names the staff replies credited to nobody, so member rows adding up short is explained", () => {
    const result = computeTeamReport(messages, { ...base, assignedMemberFor: assigned, memberId: null });
    expect(result.summary.unattributedStaffReplies).toBe(1);
    expect(result.summary.memberReplies).toBe(2);
  });
});
