import { describe, expect, it } from "vitest";
import { createSenderResolver } from "../whatsappIdentity.js";

/**
 * Workstream F §10.3: a customer whose number later joins the team keeps their customer history.
 * `attributeFrom` is applied only when the caller passes the message's time — reports do; the live
 * pipeline does not, so anyone on the roster is staff for automation now.
 */
const JOINED = Date.UTC(2026, 9, 1, 4, 0, 0);
const BEFORE = JOINED - 3_600_000;
const AFTER = JOINED + 3_600_000;

describe("attribute-from date", () => {
  const resolver = createSenderResolver([
    { id: "rina", phoneNumber: "+8801711000001", whatsappId: null, attributeFrom: new Date(JOINED) },
    { id: "tanvir", phoneNumber: "+8801711000002", whatsappId: "123456789012345@lid", attributeFrom: null },
  ]);

  it("credits nobody before the date, and the member from it on", () => {
    expect(resolver.resolve("8801711000001", "8801711000001@c.us", BEFORE)).toMatchObject({ status: "UNRESOLVED", memberId: null, isRosterMember: false });
    expect(resolver.resolve("8801711000001", "8801711000001@c.us", JOINED)).toMatchObject({ status: "PHONE_MATCH", memberId: "rina", isRosterMember: true });
    expect(resolver.resolve("8801711000001", "8801711000001@c.us", AFTER)).toMatchObject({ memberId: "rina" });
  });

  it("is ignored when no time is given — the live pipeline's call", () => {
    expect(resolver.resolve("8801711000001", "8801711000001@c.us")).toMatchObject({ memberId: "rina", isRosterMember: true });
  });

  it("leaves members without a date exactly as before, at any time", () => {
    expect(resolver.resolve("123456789012345", "123456789012345@lid", BEFORE)).toMatchObject({ status: "WHATSAPP_ID_MATCH", memberId: "tanvir" });
  });

  it("decides a shared identifier on the members who were on the team at the time", () => {
    // Bipul typed Rina's number as his own before she joined: AMBIGUOUS once both count, but only
    // Bipul's before her date — the earlier messages are his, not nobody's.
    const shared = createSenderResolver([
      { id: "rina", phoneNumber: "+8801711000001", whatsappId: null, attributeFrom: JOINED },
      { id: "bipul", phoneNumber: "8801711000001", whatsappId: null },
    ]);
    expect(shared.resolve("8801711000001", null, BEFORE)).toMatchObject({ status: "PHONE_MATCH", memberId: "bipul" });
    expect(shared.resolve("8801711000001", null, AFTER)).toMatchObject({ status: "AMBIGUOUS", memberId: null, isRosterMember: true });
  });
});
