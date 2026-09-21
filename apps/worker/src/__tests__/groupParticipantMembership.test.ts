import { describe, expect, it } from "vitest";
import {
  buildGroupRoster,
  decideMembership,
  isPhoneNumberId,
  type GroupRoster,
} from "../queue/groupParticipantMembership.js";
import { MockProvider } from "./mockProvider.js";

/**
 * Pure unit tests — no database, no provider. The membership decision is the safety-critical part
 * of this feature (a wrong "not a member" spends the one WhatsApp operation that carries a ban
 * risk), so it is tested directly rather than through the queue.
 */

const phoneRoster = (...numbers: string[]): GroupRoster =>
  buildGroupRoster(numbers.map((n) => MockProvider.phoneParticipant(n)));

const base = {
  roster: phoneRoster("8801111111111"),
  isAdminOfGroup: true as boolean | null,
  existsOnWhatsApp: true as boolean | null,
  groupAvailable: true,
};

describe("isPhoneNumberId", () => {
  it("accepts a @c.us id and rejects a LID", () => {
    expect(isPhoneNumberId("8801111111111@c.us")).toBe(true);
    expect(isPhoneNumberId("123456789012345@lid")).toBe(false);
  });
});

describe("buildGroupRoster", () => {
  it("counts a LID as opaque rather than as a phone number", () => {
    const roster = buildGroupRoster([
      MockProvider.phoneParticipant("8801111111111"),
      MockProvider.lidParticipant("123456789012345"),
    ]);
    expect(roster.phoneDigits.has("8801111111111")).toBe(true);
    // The LID's digits must NOT land in the phone set — that is the whole failure mode.
    expect(roster.phoneDigits.has("123456789012345")).toBe(false);
    expect(roster.opaqueCount).toBe(1);
    expect(roster.total).toBe(2);
  });
});

describe("decideMembership", () => {
  it("reports ALREADY_MEMBER when the roster holds the number", () => {
    expect(decideMembership({ ...base, phoneNumber: "8801111111111" })).toBe("ALREADY_MEMBER");
  });

  it("matches on digits, not formatting", () => {
    expect(decideMembership({ ...base, phoneNumber: "+880 111-111-1111" })).toBe("ALREADY_MEMBER");
  });

  it("reports READY when the number is absent from a fully readable roster", () => {
    expect(decideMembership({ ...base, phoneNumber: "8802222222222" })).toBe("READY");
  });

  /**
   * The case this whole design turns on. The person is not matched, but the roster identifies
   * somebody by a LID — which could be them. Saying READY here is what spends a redundant add.
   */
  it("reports CANNOT_VERIFY rather than READY when the roster contains a LID", () => {
    const roster = buildGroupRoster([
      MockProvider.phoneParticipant("8801111111111"),
      MockProvider.lidParticipant("123456789012345"),
    ]);
    expect(decideMembership({ ...base, roster, phoneNumber: "8802222222222" })).toBe("CANNOT_VERIFY");
  });

  it("still reports ALREADY_MEMBER when a LID is present but the number itself matched", () => {
    const roster = buildGroupRoster([
      MockProvider.phoneParticipant("8801111111111"),
      MockProvider.lidParticipant("123456789012345"),
    ]);
    expect(decideMembership({ ...base, roster, phoneNumber: "8801111111111" })).toBe("ALREADY_MEMBER");
  });

  it("reports INVALID_NUMBER before anything else", () => {
    expect(decideMembership({ ...base, phoneNumber: "abc" })).toBe("INVALID_NUMBER");
  });

  it("reports NOT_ON_WHATSAPP when no account exists for the number", () => {
    expect(
      decideMembership({ ...base, phoneNumber: "8802222222222", existsOnWhatsApp: false }),
    ).toBe("NOT_ON_WHATSAPP");
  });

  it("prefers roster evidence over a number lookup that says the account does not exist", () => {
    // A roster hit is direct evidence; checkNumberStatus is a lookup that can be wrong about a
    // number plainly sitting in the group.
    expect(
      decideMembership({ ...base, phoneNumber: "8801111111111", existsOnWhatsApp: false }),
    ).toBe("ALREADY_MEMBER");
  });

  it("reports NO_PERMISSION when this account is not an admin of the group", () => {
    expect(
      decideMembership({ ...base, phoneNumber: "8802222222222", isAdminOfGroup: false }),
    ).toBe("NO_PERMISSION");
  });

  /** Unknown must not behave like "not an admin" — that would refuse work the account can do. */
  it("does not block when admin status is unknown", () => {
    expect(
      decideMembership({ ...base, phoneNumber: "8802222222222", isAdminOfGroup: null }),
    ).toBe("READY");
  });

  it("reports GROUP_UNAVAILABLE when the group is gone", () => {
    expect(decideMembership({ ...base, phoneNumber: "8802222222222", groupAvailable: false })).toBe(
      "GROUP_UNAVAILABLE",
    );
  });

  it("reports CHECK_FAILED when the roster could not be read", () => {
    expect(decideMembership({ ...base, phoneNumber: "8802222222222", roster: null })).toBe("CHECK_FAILED");
  });

  /**
   * An empty roster is not a group of nobody — every group contains at least the account that read
   * it. Reading it as "nobody is in here, everyone is READY" is a transient blip turning into a
   * batch of redundant adds.
   */
  it("treats an empty roster as a failed check, never as an empty group", () => {
    expect(
      decideMembership({ ...base, phoneNumber: "8802222222222", roster: buildGroupRoster([]) }),
    ).toBe("CHECK_FAILED");
  });

  /** Point 22 of the spec: membership is (number, group), never number alone. */
  it("decides per group, so one number can be a member of one and not another", () => {
    const inGroupA = phoneRoster("8801111111111");
    const notInGroupB = phoneRoster("8809999999999");
    expect(decideMembership({ ...base, roster: inGroupA, phoneNumber: "8801111111111" })).toBe(
      "ALREADY_MEMBER",
    );
    expect(decideMembership({ ...base, roster: notInGroupB, phoneNumber: "8801111111111" })).toBe(
      "READY",
    );
  });
});
