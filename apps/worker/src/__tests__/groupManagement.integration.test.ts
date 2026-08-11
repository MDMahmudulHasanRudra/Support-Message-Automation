import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { WhatsAppAccount } from "@prisma/client";
import { processOneCommand, syncGroups } from "../commands/commandProcessor.js";
import { MockProvider } from "./mockProvider.js";

/**
 * Priority 1 (Group Management): the isActive deactivation sweep in
 * syncGroups() and the on-demand GET_GROUP_PARTICIPANT_COUNT command.
 * Neither touches WhatsApp for real -- MockProvider stands in, same as the
 * rest of this suite.
 */

let account: WhatsAppAccount;

function uniqueGroupJid(): string {
  return `${randomUUID().replace(/-/g, "").slice(0, 10)}-1234567890@g.us`;
}

beforeEach(async () => {
  account = await prisma.whatsAppAccount.create({ data: { label: `Group Mgmt Test Account ${randomUUID()}`, status: "CONNECTED" } });
});

afterEach(async () => {
  await prisma.whatsAppAccount.delete({ where: { id: account.id } }); // cascades groups + commands' effects via groupId FK SetNull
});

describe("syncGroups: isActive deactivation sweep", () => {
  it("creates new groups as isActive: true", async () => {
    const provider = new MockProvider();
    const jid = uniqueGroupJid();
    provider.getGroups = async () => [{ whatsappGroupId: jid, name: "Fresh Group" }];

    await syncGroups(account.id, provider);

    const group = await prisma.whatsAppGroup.findUniqueOrThrow({
      where: { accountId_whatsappGroupId: { accountId: account.id, whatsappGroupId: jid } },
    });
    expect(group.isActive).toBe(true);
  });

  it("deactivates a previously-active group the account has since left, without deleting it", async () => {
    const jidStillIn = uniqueGroupJid();
    const jidLeft = uniqueGroupJid();
    const provider = new MockProvider();

    provider.getGroups = async () => [
      { whatsappGroupId: jidStillIn, name: "Still In This One" },
      { whatsappGroupId: jidLeft, name: "About To Leave" },
    ];
    await syncGroups(account.id, provider); // both created, both isActive: true

    provider.getGroups = async () => [{ whatsappGroupId: jidStillIn, name: "Still In This One" }]; // account left the second
    await syncGroups(account.id, provider);

    const stillIn = await prisma.whatsAppGroup.findUniqueOrThrow({
      where: { accountId_whatsappGroupId: { accountId: account.id, whatsappGroupId: jidStillIn } },
    });
    const left = await prisma.whatsAppGroup.findUniqueOrThrow({
      where: { accountId_whatsappGroupId: { accountId: account.id, whatsappGroupId: jidLeft } },
    });
    expect(stillIn.isActive).toBe(true);
    expect(left.isActive).toBe(false); // deactivated, not deleted
  });

  it("reactivates a group that reappears in a later sync", async () => {
    const jid = uniqueGroupJid();
    const provider = new MockProvider();

    provider.getGroups = async () => [{ whatsappGroupId: jid, name: "Comes And Goes" }];
    await syncGroups(account.id, provider);

    const otherJid = uniqueGroupJid();
    provider.getGroups = async () => [{ whatsappGroupId: otherJid, name: "Only This One Now" }];
    await syncGroups(account.id, provider);
    let group = await prisma.whatsAppGroup.findUniqueOrThrow({
      where: { accountId_whatsappGroupId: { accountId: account.id, whatsappGroupId: jid } },
    });
    expect(group.isActive).toBe(false);

    provider.getGroups = async () => [
      { whatsappGroupId: jid, name: "Comes And Goes" },
      { whatsappGroupId: otherJid, name: "Only This One Now" },
    ];
    await syncGroups(account.id, provider);
    group = await prisma.whatsAppGroup.findUniqueOrThrow({
      where: { accountId_whatsappGroupId: { accountId: account.id, whatsappGroupId: jid } },
    });
    expect(group.isActive).toBe(true);
  });

  it("REGRESSION: an empty getGroups() result must never mass-deactivate every existing group (e.g. a transient disconnected-client blip)", async () => {
    const jid1 = uniqueGroupJid();
    const jid2 = uniqueGroupJid();
    const provider = new MockProvider();

    provider.getGroups = async () => [
      { whatsappGroupId: jid1, name: "Group One" },
      { whatsappGroupId: jid2, name: "Group Two" },
    ];
    await syncGroups(account.id, provider);

    provider.getGroups = async () => []; // simulates provider.client being null mid-reconnect
    await syncGroups(account.id, provider);

    const groups = await prisma.whatsAppGroup.findMany({ where: { accountId: account.id } });
    expect(groups.every((g) => g.isActive)).toBe(true);
  });
});

describe("GET_GROUP_PARTICIPANT_COUNT command", () => {
  it("fetches and persists the participant count for exactly the requested group", async () => {
    const group = await prisma.whatsAppGroup.create({
      data: { accountId: account.id, whatsappGroupId: uniqueGroupJid(), name: "Needs A Count" },
    });
    const command = await prisma.workerCommand.create({
      data: { type: "GET_GROUP_PARTICIPANT_COUNT", payload: { groupId: group.id } },
    });

    const provider = new MockProvider();
    provider.participantCountByChatId.set(group.whatsappGroupId, 17);

    const handled = await processOneCommand(account.id, provider);
    expect(handled).toBe(true);

    const refreshedGroup = await prisma.whatsAppGroup.findUniqueOrThrow({ where: { id: group.id } });
    expect(refreshedGroup.participantCount).toBe(17);

    const refreshedCommand = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(refreshedCommand.status).toBe("DONE");
    expect(refreshedCommand.result).toMatchObject({ groupId: group.id, participantCount: 17 });
  });

  it("fails cleanly (not silently) when the payload is missing groupId", async () => {
    const command = await prisma.workerCommand.create({ data: { type: "GET_GROUP_PARTICIPANT_COUNT", payload: {} } });
    const provider = new MockProvider();

    await processOneCommand(account.id, provider);

    const refreshed = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(refreshed.status).toBe("FAILED");
  });

  it("never touches any other group's participantCount", async () => {
    const target = await prisma.whatsAppGroup.create({
      data: { accountId: account.id, whatsappGroupId: uniqueGroupJid(), name: "Target" },
    });
    const other = await prisma.whatsAppGroup.create({
      data: { accountId: account.id, whatsappGroupId: uniqueGroupJid(), name: "Other", participantCount: 5 },
    });
    await prisma.workerCommand.create({ data: { type: "GET_GROUP_PARTICIPANT_COUNT", payload: { groupId: target.id } } });

    const provider = new MockProvider();
    provider.participantCountByChatId.set(target.whatsappGroupId, 99);
    await processOneCommand(account.id, provider);

    const refreshedOther = await prisma.whatsAppGroup.findUniqueOrThrow({ where: { id: other.id } });
    expect(refreshedOther.participantCount).toBe(5); // untouched
  });
});
