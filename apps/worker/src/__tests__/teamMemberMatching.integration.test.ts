import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, inIsp } from "./helpers/projectFixtures.js";
import { isActiveTeamMember, resolveActiveTeamMember } from "../pipeline/teamFilter.js";

/**
 * Recognising your own staff is the single load-bearing check in this system: it decides whether
 * a message is a customer's or a colleague's, which in turn decides whether automation replies to
 * it, whether an escalation case opens against it, whether support activity is recorded, and
 * whether the AI pauses because a human stepped in.
 *
 * It was comparing raw strings. WhatsApp delivers a sender as a JID ("8801XXXXXXXXX@c.us") while
 * people enter colleagues as "+8801XXXXXXXXX", so nothing ever matched and every team member was
 * silently processed as a customer. These tests pin every format either side can realistically
 * be in.
 */

const createdIds: string[] = [];

async function makeMember(
  phoneNumber: string,
  status: "ACTIVE" | "INACTIVE" = "ACTIVE",
  whatsappId?: string,
) {
  const member = await prisma.internalTeamMember.create({
    data: { name: `Matching Test ${randomUUID()}`, phoneNumber, whatsappId, role: "Support", status },
  });
  createdIds.push(member.id);
  return member;
}

beforeAll(async () => {
  // A stray ACTIVE member from another suite would make a "not a team member" assertion pass or
  // fail for the wrong reason, so this suite works against numbers it creates itself.
});

afterEach(async () => {
  if (createdIds.length) {
    await prisma.internalTeamMember.deleteMany({ where: { id: { in: createdIds } } });
    createdIds.length = 0;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("team member matching — sender formats WhatsApp actually delivers", () => {
  it("matches a bare JID against a roster number stored with a plus", async () => {
    // The exact combination that was broken in production.
    const member = await makeMember("+8801700000123");
    expect(await inIsp(() => resolveActiveTeamMember("8801700000123@c.us"))).toMatchObject({ id: member.id });
  });

  it("matches a plain digits-only sender", async () => {
    const member = await makeMember("+8801700000123");
    expect(await inIsp(() => resolveActiveTeamMember("8801700000123"))).toMatchObject({ id: member.id });
  });

  it("matches a group JID form (@g.us) as well as a contact one", async () => {
    const member = await makeMember("8801700000123");
    expect(await inIsp(() => resolveActiveTeamMember("8801700000123@g.us"))).toMatchObject({ id: member.id });
  });

  it("matches when the roster number was typed with spaces and dashes", async () => {
    const member = await makeMember("+880 170-000 0123");
    expect(await inIsp(() => resolveActiveTeamMember("8801700000123@c.us"))).toMatchObject({ id: member.id });
  });

  it("matches when the roster number has no plus and the sender does", async () => {
    const member = await makeMember("8801700000123");
    expect(await inIsp(() => resolveActiveTeamMember("+8801700000123"))).toMatchObject({ id: member.id });
  });
});

describe("team member matching — who must NOT match", () => {
  it("does not match a different number", async () => {
    await makeMember("+8801700000123");
    expect(await inIsp(() => resolveActiveTeamMember("8801700000999@c.us"))).toBeNull();
  });

  it("does not match an INACTIVE member", async () => {
    // Deactivating someone has to actually stop them counting as staff, or a departed colleague
    // keeps suppressing automation.
    await makeMember("+8801700000123", "INACTIVE");
    expect(await inIsp(() => resolveActiveTeamMember("8801700000123@c.us"))).toBeNull();
  });

  it("does not match a number that only shares a suffix", async () => {
    // Digits-only comparison must stay an equality, never a contains — otherwise a customer
    // whose number ends the same way would be treated as staff.
    await makeMember("+8801700000123");
    expect(await inIsp(() => resolveActiveTeamMember("447700000123@c.us"))).toBeNull();
  });

  it("returns null for junk input rather than throwing", async () => {
    await makeMember("+8801700000123");
    for (const junk of ["", "@c.us", "not-a-number", "12"]) {
      expect(await inIsp(() => resolveActiveTeamMember(junk))).toBeNull();
    }
  });
});

describe("WhatsApp LID senders", () => {
  /**
   * WhatsApp migrated group participants to a "LID" — a 14-15 digit identifier that is
   * deliberately not the person's phone number, so their real number never appears on a message
   * sent in a group. This was found in production: 1,118 of 1,151 stored messages carried a
   * 14-15 digit sender, and a roster member ("Mhafuz Rhaman", stored as 8801894431222) was
   * arriving as 161679983804516. Every colleague was being processed as a customer again.
   */
  it("matches a member by the identifier WhatsApp actually sends", async () => {
    const member = await makeMember("+8801894431222", "ACTIVE", "161679983804516");
    expect(await inIsp(() => resolveActiveTeamMember("161679983804516"))).toMatchObject({ id: member.id });
  });

  it("still matches that member by phone number, so nothing regresses", async () => {
    const member = await makeMember("+8801894431222", "ACTIVE", "161679983804516");
    expect(await inIsp(() => resolveActiveTeamMember("8801894431222@c.us"))).toMatchObject({ id: member.id });
  });

  it("keeps matching after an admin corrects the phone number to the real one", async () => {
    // The reason the identifier is stored separately rather than in phoneNumber: editing the
    // human-readable number must never silently stop the person being recognised.
    const member = await makeMember("161679983804516", "ACTIVE", "161679983804516");
    await prisma.internalTeamMember.update({
      where: { id: member.id },
      data: { phoneNumber: "+8801894431222" },
    });
    expect(await inIsp(() => resolveActiveTeamMember("161679983804516"))).toMatchObject({ id: member.id });
  });

  it("does not match a different LID", async () => {
    await makeMember("+8801894431222", "ACTIVE", "161679983804516");
    expect(await inIsp(() => resolveActiveTeamMember("222200183419092"))).toBeNull();
  });

  it("does not match an INACTIVE member by their LID either", async () => {
    await makeMember("+8801894431222", "INACTIVE", "161679983804516");
    expect(await inIsp(() => resolveActiveTeamMember("161679983804516"))).toBeNull();
  });

  it("compares a LID exactly, never by digits", async () => {
    // A LID is opaque — there is no format a person could have typed wrongly, and loose matching
    // would risk colliding with a real phone number that shares its digits.
    await makeMember("+8801894431222", "ACTIVE", "161679983804516");
    expect(await inIsp(() => resolveActiveTeamMember("+16167998380 4516"))).toBeNull();
  });

  it("ignores an empty whatsappId rather than matching everything", async () => {
    await makeMember("+8801700000123");
    expect(await inIsp(() => resolveActiveTeamMember(""))).toBeNull();
  });
});

describe("isActiveTeamMember", () => {
  it("agrees with resolveActiveTeamMember", async () => {
    await makeMember("+8801700000123");
    expect(await inIsp(() => isActiveTeamMember("8801700000123@c.us"))).toBe(true);
    expect(await inIsp(() => isActiveTeamMember("8801700000999@c.us"))).toBe(false);
  });
});
