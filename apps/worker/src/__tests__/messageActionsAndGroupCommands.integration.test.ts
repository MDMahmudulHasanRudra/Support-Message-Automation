import "./helpers/requireTestDatabase.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { WhatsAppAccount } from "@prisma/client";
import { processOneCommand } from "../commands/commandProcessor.js";
import { MockProvider } from "./mockProvider.js";

/**
 * REACT_TO_MESSAGE, EDIT_MESSAGE, CREATE_GROUP, JOIN_GROUP, UPDATE_PROFILE — the five live-browser
 * commands added alongside the existing RECONNECT/SEND_LIVE_TEST family. Each is exercised
 * for: the happy path, missing-payload rejection, and provider-reported failure landing as FAILED
 * with the reason preserved rather than swallowed.
 */

let account: WhatsAppAccount;

beforeEach(async () => {
  account = await prisma.whatsAppAccount.create({
    data: { label: `Message Actions Test ${randomUUID()}`, status: "CONNECTED", phoneNumber: "+8801000000000" },
  });
});

afterEach(async () => {
  await prisma.whatsAppAccount.delete({ where: { id: account.id } });
});

describe("REACT_TO_MESSAGE", () => {
  it("reacts and reports DONE", async () => {
    const provider = new MockProvider();
    const command = await prisma.workerCommand.create({
      data: { type: "REACT_TO_MESSAGE", payload: { whatsappMessageId: "msg-1", emoji: "👍" } },
    });

    await processOneCommand(account.id, provider);

    expect(provider.reactions).toEqual([{ whatsappMessageId: "msg-1", emoji: "👍" }]);
    const refreshed = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(refreshed.status).toBe("DONE");
    expect(refreshed.result).toMatchObject({ success: true });
  });

  it("rejects a payload missing the message id or emoji", async () => {
    const provider = new MockProvider();
    const command = await prisma.workerCommand.create({ data: { type: "REACT_TO_MESSAGE", payload: {} } });

    await processOneCommand(account.id, provider);

    const refreshed = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(refreshed.status).toBe("FAILED");
    expect(provider.reactions).toHaveLength(0);
  });

  it("reports a provider failure as FAILED with the reason kept", async () => {
    const provider = new MockProvider();
    provider.nextReactionResult = { success: false, error: "The reaction was not accepted." };
    const command = await prisma.workerCommand.create({
      data: { type: "REACT_TO_MESSAGE", payload: { whatsappMessageId: "msg-1", emoji: "👍" } },
    });

    await processOneCommand(account.id, provider);

    const refreshed = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(refreshed.status).toBe("FAILED");
    expect(refreshed.result).toMatchObject({ success: false, error: "The reaction was not accepted." });
  });
});

describe("EDIT_MESSAGE", () => {
  it("edits and reports DONE, and never touches the stored Message row", async () => {
    // Stores a Message row first so the test can prove the handler does NOT rewrite it — editing
    // is a live WhatsApp action, and the stored row is the record of what was actually sent.
    const group = await prisma.whatsAppGroup.create({
      data: {
        accountId: account.id,
        whatsappGroupId: `${randomUUID()}@g.us`,
        name: "Edit Test Group",
        lastSyncedAt: new Date(),
      },
    });
    const stored = await prisma.message.create({
      data: {
        accountId: account.id,
        groupId: group.id,
        whatsappMessageId: "msg-to-edit",
        chatId: group.whatsappGroupId,
        senderPhone: "8801000000000",
        direction: "OUTGOING",
        body: "original text",
        normalizedBody: "original text",
        timestampWa: new Date(),
        processingStatus: "PROCESSED",
      },
    });

    const provider = new MockProvider();
    const command = await prisma.workerCommand.create({
      data: { type: "EDIT_MESSAGE", payload: { whatsappMessageId: "msg-to-edit", newBody: "corrected text" } },
    });

    await processOneCommand(account.id, provider);

    expect(provider.edits).toEqual([{ whatsappMessageId: "msg-to-edit", newBody: "corrected text" }]);
    const refreshedCommand = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(refreshedCommand.status).toBe("DONE");

    const refreshedMessage = await prisma.message.findUniqueOrThrow({ where: { id: stored.id } });
    expect(refreshedMessage.body).toBe("original text");
  });

  it("reports an experimental-feature failure as an ordinary FAILED, not a thrown error", async () => {
    const provider = new MockProvider();
    provider.nextEditResult = {
      success: false,
      error: "This account cannot edit messages, or the message is too old to edit.",
    };
    const command = await prisma.workerCommand.create({
      data: { type: "EDIT_MESSAGE", payload: { whatsappMessageId: "msg-1", newBody: "x" } },
    });

    await processOneCommand(account.id, provider);

    const refreshed = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(refreshed.status).toBe("FAILED");
    expect((refreshed.result as { error: string }).error).toMatch(/cannot edit/);
  });
});

describe("CREATE_GROUP", () => {
  it("normalises contact numbers to digits before calling the provider", async () => {
    const provider = new MockProvider();
    const command = await prisma.workerCommand.create({
      data: {
        type: "CREATE_GROUP",
        payload: { groupName: "New Support Group", contactPhoneNumbers: ["+880 171-1111111", "8801722222222"] },
      },
    });

    await processOneCommand(account.id, provider);

    expect(provider.createdGroups).toEqual([
      { groupName: "New Support Group", contactPhoneNumbers: ["8801711111111", "8801722222222"] },
    ]);
    const refreshed = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(refreshed.status).toBe("DONE");
    expect(refreshed.result).toMatchObject({ success: true, name: "New Support Group" });
  });

  it("rejects a payload with no contacts, without calling the provider", async () => {
    const provider = new MockProvider();
    const command = await prisma.workerCommand.create({
      data: { type: "CREATE_GROUP", payload: { groupName: "Lonely Group", contactPhoneNumbers: [] } },
    });

    await processOneCommand(account.id, provider);

    expect(provider.createdGroups).toHaveLength(0);
    const refreshed = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(refreshed.status).toBe("FAILED");
  });
});

describe("JOIN_GROUP", () => {
  it("joins via the invite link and reports the group id", async () => {
    const provider = new MockProvider();
    provider.nextJoinGroupResult = { success: true, whatsappGroupId: "1234567890-1234567890@g.us" };
    const command = await prisma.workerCommand.create({
      data: { type: "JOIN_GROUP", payload: { inviteLink: "https://chat.whatsapp.com/AbCdEf123" } },
    });

    await processOneCommand(account.id, provider);

    expect(provider.joinedInviteLinks).toEqual(["https://chat.whatsapp.com/AbCdEf123"]);
    const refreshed = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(refreshed.status).toBe("DONE");
    expect(refreshed.result).toMatchObject({ success: true, whatsappGroupId: "1234567890-1234567890@g.us" });
  });

  it("reports an expired or invalid link as FAILED with the reason kept", async () => {
    const provider = new MockProvider();
    provider.nextJoinGroupResult = { success: false, error: "The invite link is invalid or has expired." };
    const command = await prisma.workerCommand.create({
      data: { type: "JOIN_GROUP", payload: { inviteLink: "https://chat.whatsapp.com/expired" } },
    });

    await processOneCommand(account.id, provider);

    const refreshed = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(refreshed.status).toBe("FAILED");
    expect(refreshed.result).toMatchObject({ error: "The invite link is invalid or has expired." });
  });
});

describe("UPDATE_PROFILE", () => {
  it("passes through only the fields the caller asked for", async () => {
    const provider = new MockProvider();
    const command = await prisma.workerCommand.create({
      data: { type: "UPDATE_PROFILE", payload: { displayName: "Softify Support" } },
    });

    await processOneCommand(account.id, provider);

    expect(provider.profileUpdates).toEqual([{ displayName: "Softify Support" }]);
    const refreshed = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(refreshed.status).toBe("DONE");
  });

  it("reports DONE with a partial result when only some fields succeed — a picture failure must not hide a name change that went through", async () => {
    const provider = new MockProvider();
    provider.nextProfileUpdateResult = { displayName: true, pictureDataUrl: false };
    const command = await prisma.workerCommand.create({
      data: {
        type: "UPDATE_PROFILE",
        payload: { displayName: "Softify Support", pictureDataUrl: "data:image/png;base64,abc" },
      },
    });

    await processOneCommand(account.id, provider);

    const refreshed = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(refreshed.status).toBe("DONE");
    expect(refreshed.result).toMatchObject({ displayName: true, pictureDataUrl: false });
  });

  it("rejects an empty payload rather than silently doing nothing", async () => {
    const provider = new MockProvider();
    const command = await prisma.workerCommand.create({ data: { type: "UPDATE_PROFILE", payload: {} } });

    await processOneCommand(account.id, provider);

    expect(provider.profileUpdates).toHaveLength(0);
    const refreshed = await prisma.workerCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(refreshed.status).toBe("FAILED");
  });
});
