import { describe, expect, it } from "vitest";
import { hasReachablePhoneNumber } from "../groupParticipantAdd.js";

/**
 * Recognising a team member and being able to message them are different problems, and the
 * difference is invisible until an escalation fails to arrive.
 *
 * WhatsApp identifies group participants by a LID now, and adding someone from message history is
 * the only way to map them — but all that history carries is the LID, so it lands in `phoneNumber`
 * as well as `whatsappId`. That is fine for matching their messages. A direct message to it goes
 * nowhere, which would make a support escalation report success and reach no one.
 */

describe("hasReachablePhoneNumber", () => {
  it("accepts a member who has no WhatsApp id at all", () => {
    // Typed in by hand, the ordinary case.
    expect(hasReachablePhoneNumber({ phoneNumber: "+8801700000123" })).toBe(true);
    expect(hasReachablePhoneNumber({ phoneNumber: "+8801700000123", whatsappId: null })).toBe(true);
  });

  it("accepts a member whose real number sits alongside their WhatsApp id", () => {
    // The ideal state: mapped for recognition, and reachable for escalations.
    expect(
      hasReachablePhoneNumber({ phoneNumber: "8801842117904", whatsappId: "258076179448048" }),
    ).toBe(true);
  });

  it("rejects a member whose number IS their WhatsApp id", () => {
    // What "Add from a group" produces: nobody ever typed a number, so both fields hold the LID.
    expect(
      hasReachablePhoneNumber({ phoneNumber: "161679983804516", whatsappId: "161679983804516" }),
    ).toBe(false);
  });

  it("ignores surrounding whitespace when comparing", () => {
    expect(
      hasReachablePhoneNumber({ phoneNumber: " 161679983804516 ", whatsappId: "161679983804516" }),
    ).toBe(false);
  });

  it("becomes reachable again once a real number is entered", () => {
    // The fix an admin makes, and the thing the "Needs phone number" badge is asking for.
    expect(
      hasReachablePhoneNumber({ phoneNumber: "+8801894431222", whatsappId: "161679983804516" }),
    ).toBe(true);
  });
});
