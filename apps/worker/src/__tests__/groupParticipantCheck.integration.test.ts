import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { GroupParticipantAddSettings, Prisma, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { checkOneJob, recoverStuckParticipantChecks } from "../queue/groupParticipantCheckProcessor.js";
import { MockProvider } from "./mockProvider.js";

/**
 * The membership-check phase, end to end against a real database.
 *
 * The point of the phase is that nothing is sent: every assertion below is about what the job
 * KNOWS before a single WhatsApp add is spent, so each test also asserts that no add was attempted.
 */

let originalAddSettings: GroupParticipantAddSettings;
let account: WhatsAppAccount;

function uniqueGroupJid(): string {
  return `${randomUUID().replace(/-/g, "").slice(0, 10)}-1234567890@g.us`;
}

async function makeGroup(overrides: Partial<Pick<WhatsAppGroup, "name" | "isActive">> = {}) {
  return prisma.whatsAppGroup.create({
    data: {
      accountId: account.id,
      whatsappGroupId: uniqueGroupJid(),
      name: overrides.name ?? `Check Group ${randomUUID().slice(0, 8)}`,
      isActive: overrides.isActive ?? true,
      lastSyncedAt: new Date(),
    },
  });
}

async function makeCheckingJob() {
  const settings = await prisma.groupParticipantAddSettings.findUniqueOrThrow({ where: { id: "global" } });
  return prisma.groupParticipantAddJob.create({
    data: {
      accountId: account.id,
      phoneNumbers: ["8801000000000"],
      totalRequested: 1,
      queuedCount: 0,
      status: "CHECKING",
      delayMinMs: settings.delayMinMs,
      delayMaxMs: settings.delayMaxMs,
      maxPerMinute: settings.maxPerMinute,
      maxPerJob: settings.maxPerJob,
      retryMaxAttempts: settings.retryMaxAttempts,
    },
  });
}

async function pendingCheckItem(params: { job: { id: string }; group: WhatsAppGroup; phoneNumber?: string }) {
  return prisma.groupParticipantAddItem.create({
    data: {
      jobId: params.job.id,
      groupId: params.group.id,
      groupNameSnapshot: params.group.name,
      phoneNumber: params.phoneNumber ?? "8801000000000",
      status: "PENDING_CHECK",
    },
  });
}

const statusOf = async (id: string) =>
  (await prisma.groupParticipantAddItem.findUniqueOrThrow({ where: { id } })).status;

beforeAll(async () => {
  originalAddSettings = await prisma.groupParticipantAddSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
});

afterAll(async () => {
  await prisma.groupParticipantAddSettings.update({
    where: { id: "global" },
    data: originalAddSettings as unknown as Prisma.GroupParticipantAddSettingsUpdateInput,
  });
});

beforeEach(async () => {
  await prisma.groupParticipantAddSettings.update({
    where: { id: "global" },
    data: { delayMinMs: 0, delayMaxMs: 0, maxPerMinute: 100, maxPerJob: 100, retryMaxAttempts: 2 },
  });
  account = await prisma.whatsAppAccount.create({
    data: { label: `Participant Check Test Account ${randomUUID()}`, status: "CONNECTED" },
  });
});

afterEach(async () => {
  await prisma.whatsAppAccount.delete({ where: { id: account.id } });
});

describe("membership check: already a member vs ready", () => {
  it("marks a number already in the group ALREADY_MEMBER without attempting an add", async () => {
    const group = await makeGroup();
    const job = await makeCheckingJob();
    const item = await pendingCheckItem({ job, group });

    const provider = new MockProvider();
    provider.participantsByChatId.set(group.whatsappGroupId, [
      MockProvider.phoneParticipant("8801000000000", "Already In"),
    ]);

    await checkOneJob(provider, job.id);

    expect(await statusOf(item.id)).toBe("ALREADY_MEMBER");
    // The entire point of the phase.
    expect(provider.addedParticipants).toHaveLength(0);
  });

  it("marks a number absent from the group READY", async () => {
    const group = await makeGroup();
    const job = await makeCheckingJob();
    const item = await pendingCheckItem({ job, group });

    const provider = new MockProvider();
    provider.participantsByChatId.set(group.whatsappGroupId, [
      MockProvider.phoneParticipant("8809999999999", "Somebody Else"),
    ]);

    await checkOneJob(provider, job.id);

    expect(await statusOf(item.id)).toBe("READY");
    expect(provider.addedParticipants).toHaveLength(0);
  });

  it("records when the check ran", async () => {
    const group = await makeGroup();
    const job = await makeCheckingJob();
    const item = await pendingCheckItem({ job, group });

    const provider = new MockProvider();
    provider.participantsByChatId.set(group.whatsappGroupId, [MockProvider.phoneParticipant("8809999999999")]);
    await checkOneJob(provider, job.id);

    const refreshed = await prisma.groupParticipantAddItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(refreshed.checkedAt).not.toBeNull();
  });
});

/** Point 22: membership is (number, group), never number alone. */
describe("membership is per group, not per number", () => {
  it("reports the same number as a member of one group and ready for another", async () => {
    const groupA = await makeGroup({ name: "Group A" });
    const groupB = await makeGroup({ name: "Group B" });
    const job = await makeCheckingJob();
    const inA = await pendingCheckItem({ job, group: groupA });
    const notInB = await pendingCheckItem({ job, group: groupB });

    const provider = new MockProvider();
    provider.participantsByChatId.set(groupA.whatsappGroupId, [MockProvider.phoneParticipant("8801000000000")]);
    provider.participantsByChatId.set(groupB.whatsappGroupId, [MockProvider.phoneParticipant("8807777777777")]);

    await checkOneJob(provider, job.id);

    expect(await statusOf(inA.id)).toBe("ALREADY_MEMBER");
    expect(await statusOf(notInB.id)).toBe("READY");
  });
});

describe("numbers WhatsApp cannot accept", () => {
  it("marks a number with no WhatsApp account NOT_ON_WHATSAPP", async () => {
    const group = await makeGroup();
    const job = await makeCheckingJob();
    const item = await pendingCheckItem({ job, group, phoneNumber: "8805555555555" });

    const provider = new MockProvider();
    provider.participantsByChatId.set(group.whatsappGroupId, [MockProvider.phoneParticipant("8809999999999")]);
    provider.numberChecks.set("8805555555555", { ok: true, exists: false });

    await checkOneJob(provider, job.id);

    expect(await statusOf(item.id)).toBe("NOT_ON_WHATSAPP");
    expect(provider.addedParticipants).toHaveLength(0);
  });
});

describe("permission", () => {
  it("marks every pair in a group this account does not administer NO_PERMISSION", async () => {
    const group = await makeGroup();
    const job = await makeCheckingJob();
    const item = await pendingCheckItem({ job, group });

    const provider = new MockProvider();
    provider.participantsByChatId.set(group.whatsappGroupId, [MockProvider.phoneParticipant("8809999999999")]);
    // Configured, and this group is not in the list.
    provider.adminGroupIdsConfigured = true;
    provider.adminGroupIds = ["some-other-group@g.us"];

    await checkOneJob(provider, job.id);

    expect(await statusOf(item.id)).toBe("NO_PERMISSION");
    expect(provider.addedParticipants).toHaveLength(0);
  });

  it("does not block when admin status is unknown", async () => {
    const group = await makeGroup();
    const job = await makeCheckingJob();
    const item = await pendingCheckItem({ job, group });

    const provider = new MockProvider();
    provider.participantsByChatId.set(group.whatsappGroupId, [MockProvider.phoneParticipant("8809999999999")]);
    // Left unconfigured — getAdminGroupIds returns null.

    await checkOneJob(provider, job.id);

    expect(await statusOf(item.id)).toBe("READY");
  });
});

describe("unreadable rosters", () => {
  it("marks a pair CHECK_FAILED when the roster comes back empty rather than calling it absent", async () => {
    const group = await makeGroup();
    const job = await makeCheckingJob();
    const item = await pendingCheckItem({ job, group });

    // No roster registered — the mock returns []. A group always contains at least us, so an
    // empty read is a failure, and reading it as "nobody is here" would make everyone READY.
    const provider = new MockProvider();

    await checkOneJob(provider, job.id);

    expect(await statusOf(item.id)).toBe("CHECK_FAILED");
    expect(provider.addedParticipants).toHaveLength(0);
  });

  it("marks a pair GROUP_UNAVAILABLE when the group is no longer active", async () => {
    const group = await makeGroup({ isActive: false });
    const job = await makeCheckingJob();
    const item = await pendingCheckItem({ job, group });

    const provider = new MockProvider();
    await checkOneJob(provider, job.id);

    expect(await statusOf(item.id)).toBe("GROUP_UNAVAILABLE");
  });
});

describe("the job's own lifecycle", () => {
  it("moves to AWAITING_REVIEW once everything has been checked, and queues nothing", async () => {
    const group = await makeGroup();
    const job = await makeCheckingJob();
    await pendingCheckItem({ job, group });

    const provider = new MockProvider();
    provider.participantsByChatId.set(group.whatsappGroupId, [MockProvider.phoneParticipant("8809999999999")]);

    await checkOneJob(provider, job.id);

    const refreshed = await prisma.groupParticipantAddJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(refreshed.status).toBe("AWAITING_REVIEW");
    // Nothing is queued to send until a person confirms.
    expect(refreshed.queuedCount).toBe(0);
  });

  it("waits for review even when every pair turned out to be a member already", async () => {
    const group = await makeGroup();
    const job = await makeCheckingJob();
    await pendingCheckItem({ job, group });

    const provider = new MockProvider();
    provider.participantsByChatId.set(group.whatsappGroupId, [MockProvider.phoneParticipant("8801000000000")]);

    await checkOneJob(provider, job.id);

    // The answer "everybody is already in" is what the operator asked for; auto-completing would
    // throw it away before it was read.
    expect((await prisma.groupParticipantAddJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(
      "AWAITING_REVIEW",
    );
  });
});

/**
 * Spec point 14. The pre-check catches most repeats, but the guarantee cannot rest on it: somebody
 * can join between the check and their turn in a queue paced at three a minute, and a LID roster
 * cannot be matched at all. WhatsApp's own 409 is the backstop that makes a repeat run settle as a
 * skip rather than a duplicate add.
 */
describe("idempotency: running the same pair twice", () => {
  it("records a second run as ALREADY_MEMBER rather than adding again", async () => {
    const group = await makeGroup();
    const job = await makeCheckingJob();
    const first = await pendingCheckItem({ job, group });

    const provider = new MockProvider();
    provider.participantsByChatId.set(group.whatsappGroupId, [MockProvider.phoneParticipant("8809999999999")]);
    await checkOneJob(provider, job.id);
    expect(await statusOf(first.id)).toBe("READY");

    // Same pair submitted again, by which time they are in the group.
    const secondJob = await makeCheckingJob();
    const second = await pendingCheckItem({ job: secondJob, group });
    provider.participantsByChatId.set(group.whatsappGroupId, [
      MockProvider.phoneParticipant("8809999999999"),
      MockProvider.phoneParticipant("8801000000000"),
    ]);

    await checkOneJob(provider, secondJob.id);

    expect(await statusOf(second.id)).toBe("ALREADY_MEMBER");
    expect(provider.addedParticipants).toHaveLength(0);
  });
});

/** Spec point 16: a retry must re-check membership, never blindly re-attempt. */
describe("retry re-checks before adding", () => {
  it("re-checks a failed pair and reports it as a member if they joined meanwhile", async () => {
    const group = await makeGroup();
    const job = await makeCheckingJob();
    const item = await pendingCheckItem({ job, group });

    // The pair previously failed an add.
    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: { status: "FAILED", failureReason: "WhatsApp rejected the request.", attemptCount: 1 },
    });
    // The re-check action puts it back to PENDING_CHECK; simulate that transition.
    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: { status: "PENDING_CHECK", failureReason: null, attemptCount: 0 },
    });

    const provider = new MockProvider();
    // They joined in the meantime.
    provider.participantsByChatId.set(group.whatsappGroupId, [MockProvider.phoneParticipant("8801000000000")]);

    await checkOneJob(provider, job.id);

    expect(await statusOf(item.id)).toBe("ALREADY_MEMBER");
    // The whole point: the retry cost no WhatsApp add at all.
    expect(provider.addedParticipants).toHaveLength(0);
  });

  it("re-checks a failed pair and offers it again when it is still genuinely missing", async () => {
    const group = await makeGroup();
    const job = await makeCheckingJob();
    const item = await pendingCheckItem({ job, group });

    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: { status: "PENDING_CHECK", attemptCount: 0 },
    });

    const provider = new MockProvider();
    provider.participantsByChatId.set(group.whatsappGroupId, [MockProvider.phoneParticipant("8809999999999")]);

    await checkOneJob(provider, job.id);

    expect(await statusOf(item.id)).toBe("READY");
  });
});

describe("crash recovery", () => {
  it("returns a pair stranded mid-check to PENDING_CHECK", async () => {
    const group = await makeGroup();
    const job = await makeCheckingJob();
    const item = await pendingCheckItem({ job, group });

    await prisma.groupParticipantAddItem.update({
      where: { id: item.id },
      data: { status: "CHECKING", updatedAt: new Date(Date.now() - 5 * 60_000) },
    });

    const recovered = await recoverStuckParticipantChecks();

    expect(recovered).toBeGreaterThanOrEqual(1);
    expect(await statusOf(item.id)).toBe("PENDING_CHECK");
  });
});
