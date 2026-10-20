import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_OUTCOMES,
  attributeAcrossCopies,
  attributionOutcomeOf,
  createSenderResolver,
  isEmployeeCredited,
  type AttributionOutcome,
  type IntelActor,
  type SenderMatchStatus,
} from "../index.js";

const ACTORS: IntelActor[] = ["CUSTOMER", "MEMBER", "MEMBER_UNMAPPED", "OPERATOR", "AI", "RULE", "BROADCAST", "BUSINESS_PHONE"];
const STATUSES: Array<SenderMatchStatus | null> = [
  null,
  "WHATSAPP_ID_MATCH",
  "PHONE_MATCH",
  "WHATSAPP_ID_AND_PHONE_MATCH",
  "CONFLICT",
  "AMBIGUOUS",
  "UNRESOLVED",
  "NOT_A_PERSON",
];
const kindOf = (actor: IntelActor) => (actor === "CUSTOMER" ? "CUSTOMER" : actor === "MEMBER" || actor === "MEMBER_UNMAPPED" ? "MEMBER" : "BUSINESS");

describe("attributionOutcomeOf", () => {
  it("maps every classifier decision", () => {
    // The documented table, row by row.
    const table: Array<[IntelActor, SenderMatchStatus | null, string | null, AttributionOutcome]> = [
      ["MEMBER", "WHATSAPP_ID_AND_PHONE_MATCH", "m1", "VERIFIED_ID_AND_PHONE"],
      ["MEMBER", "WHATSAPP_ID_MATCH", "m1", "VERIFIED_SINGLE_IDENTIFIER"],
      ["MEMBER", "PHONE_MATCH", "m1", "VERIFIED_SINGLE_IDENTIFIER"],
      ["OPERATOR", null, "m1", "VERIFIED_LINKED_LOGIN"],
      ["OPERATOR", null, null, "OPERATOR_UNLINKED"],
      ["MEMBER_UNMAPPED", "CONFLICT", null, "STAFF_CONFLICT"],
      ["MEMBER_UNMAPPED", "AMBIGUOUS", null, "STAFF_AMBIGUOUS"],
      ["MEMBER_UNMAPPED", "UNRESOLVED", null, "STAFF_UNMAPPED"],
      ["MEMBER_UNMAPPED", "PHONE_MATCH", null, "STAFF_UNMAPPED"],
      ["CUSTOMER", "UNRESOLVED", null, "CUSTOMER"],
      ["CUSTOMER", "NOT_A_PERSON", null, "NOT_A_PERSON"],
      ["AI", null, null, "AUTOMATED_AI"],
      ["RULE", null, null, "AUTOMATED_RULE"],
      ["BROADCAST", null, null, "BUSINESS_BROADCAST"],
      ["BUSINESS_PHONE", null, null, "BUSINESS_PHONE"],
    ];
    for (const [actor, status, memberId, expected] of table) {
      expect(attributionOutcomeOf({ kind: kindOf(actor), memberId, actor, status }), `${actor}/${status}/${memberId}`).toBe(expected);
    }
    // Every actor x status combination lands on a defined outcome — none is left unmapped.
    const reached = new Set<AttributionOutcome>();
    for (const actor of ACTORS) {
      for (const status of STATUSES) {
        for (const memberId of [null, "m1"]) {
          const outcome = attributionOutcomeOf({ kind: kindOf(actor), memberId, actor, status });
          expect(ATTRIBUTION_OUTCOMES).toContain(outcome);
          reached.add(outcome);
        }
      }
    }
    // Every outcome is reachable.
    expect([...reached].sort()).toEqual([...ATTRIBUTION_OUTCOMES].sort());
  });

  it("agrees with what the shared identity rule decides for real senders", () => {
    const resolver = createSenderResolver([
      { id: "rina", phoneNumber: "+8801000000101", whatsappId: "200000000101@lid" },
      { id: "omar", phoneNumber: "+200000000101", whatsappId: null },
    ]);
    // The classifier's own last step: staff -> MEMBER / MEMBER_UNMAPPED, otherwise CUSTOMER.
    const outcome = (phone: string, jid: string | null) => {
      const d = attributeAcrossCopies(resolver, [{ senderPhone: phone, senderJid: jid, fromTeam: false }]);
      const actor: IntelActor = d.memberId ? "MEMBER" : d.isStaff ? "MEMBER_UNMAPPED" : "CUSTOMER";
      return attributionOutcomeOf({ kind: d.isStaff ? "MEMBER" : "CUSTOMER", memberId: d.memberId, actor, status: d.status });
    };
    expect(outcome("8801000000101", "8801000000101@c.us")).toBe("VERIFIED_SINGLE_IDENTIFIER");
    expect(outcome("100000000001", "100000000001@lid")).toBe("CUSTOMER");
    // Rina's WhatsApp id is also Omar's number: two members, nobody credited.
    expect(outcome("200000000101", "200000000101@lid")).toBe("STAFF_CONFLICT");
  });

  it("isEmployeeCredited only for the three verified outcomes", () => {
    const credited = ATTRIBUTION_OUTCOMES.filter(isEmployeeCredited);
    expect(credited).toEqual(["VERIFIED_ID_AND_PHONE", "VERIFIED_SINGLE_IDENTIFIER", "VERIFIED_LINKED_LOGIN"]);
    expect(isEmployeeCredited("OPERATOR_UNLINKED")).toBe(false);
    expect(isEmployeeCredited("BUSINESS_PHONE")).toBe(false);
  });
});
