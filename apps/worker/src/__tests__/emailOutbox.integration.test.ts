import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createProjectWithDefaults, encryptSecret, prisma as rawPrisma } from "@support-automation/db";
import { withProject, resetProjectCachesForTests } from "../project/context.js";
import { resetProjectFeatureCacheForTests } from "../project/features.js";
import { EMAIL_STUCK_SENDING_MS, runEmailOutboxTick, sendNextQueued } from "../email/outboxProcessor.js";
import type { HostResolver, SmtpConnection, SmtpMessage, SmtpOutcome, SmtpSender } from "../email/smtpTransport.js";

/**
 * The email send queue (CLIENT_CENTER_PLAN.md §3.1) against a FAKE mail server: no test opens a
 * connection or sends a message.
 *
 * What must hold:
 *   - a message is claimed once; ACCEPTED is recorded as accepted, never delivered;
 *   - a TEST message verifies the channel only for the settings version it was queued under, so a
 *     changed setting must be tested again, and an old test can never verify new settings;
 *   - a failure before the message body (or a 4xx) is retried with backoff, then fails after five
 *     attempts; a refused login and a permanent refusal are never retried; a timeout AFTER the body
 *     was handed over is UNKNOWN and never retried by itself;
 *   - the project's per-minute and per-day ceilings leave rows queued rather than exceed them;
 *   - a mail server that is this machine (typed or resolved) is refused before any connection;
 *   - each project sends with its own settings, and only when it has the feature.
 */

process.env.AI_CREDENTIALS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let A = "";
let B = "";
let creator = "";
const PASSWORD_A = `pw-A-${tag}`;
const PASSWORD_B = `pw-B-${tag}`;

// ── A fake mail server ────────────────────────────────────────────────────────────────────────────
const fake = {
  calls: [] as Array<{ connection: SmtpConnection; message: SmtpMessage }>,
  next: [] as SmtpOutcome[],
  delayMs: 0,
};
const send: SmtpSender = async (connection, message) => {
  fake.calls.push({ connection, message });
  if (fake.delayMs) await new Promise((r) => setTimeout(r, fake.delayMs));
  return fake.next.shift() ?? { ok: true, providerMessageId: `<${message.messageIdSeed}@fake>` };
};
const publicHost: HostResolver = async () => ["203.0.113.10"];
const fail = (kind: "NOT_SENT" | "TEMPORARY" | "PERMANENT" | "AUTH" | "UNKNOWN", message = `fake ${kind}`): SmtpOutcome => ({ ok: false, failure: { kind, message } });

const inA = <T,>(fn: () => Promise<T>) => withProject(A, fn);
const inB = <T,>(fn: () => Promise<T>) => withProject(B, fn);

async function settingsFor(projectId: string, password: string, extra: Record<string, unknown> = {}) {
  await rawPrisma.emailSettings.deleteMany({ where: { projectId } });
  return rawPrisma.emailSettings.create({
    data: { projectId, host: "smtp.example.test", port: 587, tlsMode: "STARTTLS", username: `user-${projectId.slice(-4)}`, passwordCiphertext: encryptSecret(password), fromName: "Support", fromAddress: "support@example.test", settingsVersion: 1, ...extra },
  });
}
async function queue(projectId: string, extra: Record<string, unknown> = {}) {
  return rawPrisma.emailOutbox.create({
    data: { projectId, purpose: "TEST", toAddress: `admin-${tag}@example.test`, subject: "Test", bodyText: "Body", idempotencyKey: `k-${randomUUID()}`, settingsVersion: 1, createdById: creator, ...extra },
  });
}
const row = (id: string) => rawPrisma.emailOutbox.findUniqueOrThrow({ where: { id } });
const settingsOf = (projectId: string) => rawPrisma.emailSettings.findFirstOrThrow({ where: { projectId } });

beforeAll(async () => {
  creator = (await rawPrisma.user.create({ data: { username: `em_${tag}`, email: `em.${tag}@example.test`, name: "Em", passwordHash: "x" } })).id;
  const make = async (name: string, feature: boolean) => {
    const p = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: creator }, rawPrisma);
    if (feature) await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key: "CLIENT_CENTER" } }, create: { projectId: p.id, key: "CLIENT_CENTER", enabled: true }, update: { enabled: true } });
    return p.id;
  };
  A = await make("MailA", true);
  B = await make("MailB", true);
  resetProjectCachesForTests();
  resetProjectFeatureCacheForTests();
});

beforeEach(async () => {
  fake.calls = [];
  fake.next = [];
  fake.delayMs = 0;
  await rawPrisma.emailOutbox.deleteMany({ where: { projectId: { in: [A, B] } } });
});

afterAll(async () => {
  await rawPrisma.emailOutbox.deleteMany({ where: { projectId: { in: [A, B] } } });
  await rawPrisma.emailSettings.deleteMany({ where: { projectId: { in: [A, B] } } });
  await rawPrisma.systemLog.deleteMany({ where: { projectId: { in: [A, B] } } });
  await rawPrisma.projectFeature.deleteMany({ where: { projectId: { in: [A, B] } } });
});

describe("1. a successful test connects the channel", () => {
  it("sends with the project's own settings and the decrypted password, and records ACCEPTED (not delivered)", async () => {
    await settingsFor(A, PASSWORD_A);
    const m = await queue(A);
    expect(await inA(() => sendNextQueued(new Date(), send, publicHost))).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.connection).toMatchObject({ host: "smtp.example.test", port: 587, tlsMode: "STARTTLS", password: PASSWORD_A });
    expect(fake.calls[0]!.message).toMatchObject({ to: `admin-${tag}@example.test`, fromAddress: "support@example.test", messageIdSeed: m.id });
    const after = await row(m.id);
    expect(after).toMatchObject({ status: "ACCEPTED", attempts: 1, lastError: null });
    expect(after.providerMessageId).toContain(m.id);
    expect(await settingsOf(A)).toMatchObject({ verifiedVersion: 1, lastTestOk: true, lastTestError: null });
  });

  it("does not let a test of OLD settings verify NEW ones, and does not send it", async () => {
    await settingsFor(A, PASSWORD_A, { settingsVersion: 2 });
    const m = await queue(A, { settingsVersion: 1 });
    await inA(() => sendNextQueued(new Date(), send, publicHost));
    expect(fake.calls).toHaveLength(0);
    expect(await row(m.id)).toMatchObject({ status: "FAILED" });
    expect((await row(m.id)).lastError).toMatch(/settings were changed/);
    expect((await settingsOf(A)).verifiedVersion).toBeNull();
  });

  it("does not verify when the settings change while the test is in flight", async () => {
    await settingsFor(A, PASSWORD_A);
    const m = await queue(A);
    fake.delayMs = 150;
    const sending = inA(() => sendNextQueued(new Date(), send, publicHost));
    await new Promise((r) => setTimeout(r, 40));
    await rawPrisma.emailSettings.updateMany({ where: { projectId: A }, data: { settingsVersion: 2 } });
    await sending;
    expect((await row(m.id)).status).toBe("ACCEPTED");
    expect((await settingsOf(A)).verifiedVersion).toBeNull();
  });
});

describe("2. failures are classified, and only the safe ones are retried", () => {
  it("retries a failure before the body with backoff and gives up after five attempts", async () => {
    await settingsFor(A, PASSWORD_A);
    const m = await queue(A);
    const t0 = new Date("2026-10-13T10:00:00Z");
    fake.next = [fail("NOT_SENT"), fail("TEMPORARY"), fail("NOT_SENT"), fail("TEMPORARY"), fail("NOT_SENT")];
    let now = t0;
    const delays: number[] = [];
    for (let i = 1; i <= 5; i++) {
      expect(await inA(() => sendNextQueued(now, send, publicHost))).toBe(true);
      const r = await row(m.id);
      if (i < 5) {
        expect(r.status).toBe("QUEUED");
        delays.push(r.nextAttemptAt!.getTime() - now.getTime());
        // not due yet: nothing happens
        expect(await inA(() => sendNextQueued(new Date(now.getTime() + 1_000), send, publicHost))).toBe(false);
        now = r.nextAttemptAt!;
      } else {
        expect(r.status).toBe("FAILED");
        expect(r.lastError).toMatch(/after 5 attempts/);
      }
    }
    expect(delays).toEqual([60_000, 300_000, 900_000, 3_600_000]);
    expect(fake.calls).toHaveLength(5);
    expect(await inA(() => sendNextQueued(new Date(now.getTime() + 10 * 3_600_000), send, publicHost))).toBe(false);
  });

  it("never retries a refused login or a permanent refusal, and marks the test failed", async () => {
    await settingsFor(A, PASSWORD_A);
    for (const kind of ["AUTH", "PERMANENT"] as const) {
      const m = await queue(A);
      fake.next = [fail(kind)];
      await inA(() => sendNextQueued(new Date(), send, publicHost));
      expect(await row(m.id)).toMatchObject({ status: "FAILED", attempts: 1, nextAttemptAt: null });
      expect(await inA(() => sendNextQueued(new Date(Date.now() + 3_600_000), send, publicHost))).toBe(false);
    }
    expect(await settingsOf(A)).toMatchObject({ lastTestOk: false, verifiedVersion: null });
  });

  it("records an unknowable outcome as UNKNOWN and never retries it by itself", async () => {
    await settingsFor(A, PASSWORD_A);
    const m = await queue(A);
    fake.next = [fail("UNKNOWN", "timed out after the message was handed over")];
    await inA(() => sendNextQueued(new Date(), send, publicHost));
    expect(await row(m.id)).toMatchObject({ status: "UNKNOWN", nextAttemptAt: null });
    expect(await inA(() => sendNextQueued(new Date(Date.now() + 3_600_000), send, publicHost))).toBe(false);
    expect(fake.calls).toHaveLength(1);
    expect((await settingsOf(A)).verifiedVersion).toBeNull();
  });

  it("turns a message stuck SENDING into UNKNOWN rather than sending it again", async () => {
    await settingsFor(A, PASSWORD_A);
    const m = await queue(A, { status: "SENDING", sendingStartedAt: new Date(Date.now() - EMAIL_STUCK_SENDING_MS - 60_000), attempts: 1 });
    await runEmailOutboxTick(new Date(), send, publicHost);
    expect(await row(m.id)).toMatchObject({ status: "UNKNOWN" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("3. a message is claimed once", () => {
  it("sends one message once, however many ticks race for it", async () => {
    await settingsFor(A, PASSWORD_A, { maxPerMinute: 100 });
    const m = await queue(A);
    fake.delayMs = 60;
    const results = await Promise.all([1, 2, 3].map(() => inA(() => sendNextQueued(new Date(), send, publicHost))));
    expect(fake.calls).toHaveLength(1);
    expect(results.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect((await row(m.id)).attempts).toBe(1);
  });
});

describe("4. limits, configuration and the mail server's address", () => {
  it("leaves rows queued rather than exceed the per-minute ceiling", async () => {
    await settingsFor(A, PASSWORD_A, { maxPerMinute: 1, maxPerDay: 10 });
    const first = await queue(A);
    const second = await queue(A);
    const now = new Date();
    expect(await inA(() => sendNextQueued(now, send, publicHost))).toBe(true);
    expect(await inA(() => sendNextQueued(now, send, publicHost))).toBe(false);
    expect((await row(first.id)).status).toBe("ACCEPTED");
    expect((await row(second.id)).status).toBe("QUEUED");
    // a minute later it goes
    expect(await inA(() => sendNextQueued(new Date(now.getTime() + 61_000), send, publicHost))).toBe(true);
    expect((await row(second.id)).status).toBe("ACCEPTED");
  });

  it("leaves rows queued rather than exceed the per-day ceiling", async () => {
    await settingsFor(A, PASSWORD_A, { maxPerMinute: 50, maxPerDay: 1 });
    await queue(A);
    const second = await queue(A);
    const now = new Date();
    await inA(() => sendNextQueued(now, send, publicHost));
    expect(await inA(() => sendNextQueued(new Date(now.getTime() + 120_000), send, publicHost))).toBe(false);
    expect((await row(second.id)).status).toBe("QUEUED");
  });

  it("fails a message when the project has no complete settings", async () => {
    await rawPrisma.emailSettings.deleteMany({ where: { projectId: A } });
    const m = await queue(A);
    await inA(() => sendNextQueued(new Date(), send, publicHost));
    expect(await row(m.id)).toMatchObject({ status: "FAILED" });
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a mail server that is this machine, typed or resolved, before any connection", async () => {
    await settingsFor(A, PASSWORD_A, { host: "127.0.0.1" });
    const typed = await queue(A);
    await inA(() => sendNextQueued(new Date(), send, publicHost));
    expect((await row(typed.id)).status).toBe("FAILED");

    await settingsFor(A, PASSWORD_A, { host: "innocent.example.test" });
    const resolved = await queue(A);
    await inA(() => sendNextQueued(new Date(), send, async () => ["169.254.169.254"]));
    expect((await row(resolved.id)).status).toBe("FAILED");
    expect((await row(resolved.id)).lastError).toMatch(/not allowed/);
    expect(fake.calls).toHaveLength(0);
  });

  it("treats a name that cannot be looked up as safe to retry", async () => {
    await settingsFor(A, PASSWORD_A);
    const m = await queue(A);
    await inA(() => sendNextQueued(new Date(), send, async () => { throw new Error("ENOTFOUND"); }));
    expect((await row(m.id)).status).toBe("QUEUED");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("5. projects", () => {
  it("sends each project's message with that project's own credentials, and only where the feature is on", async () => {
    await settingsFor(A, PASSWORD_A);
    await settingsFor(B, PASSWORD_B);
    const a = await queue(A);
    const b = await queue(B);
    await runEmailOutboxTick(new Date(), send, publicHost);
    const byTo = new Map(fake.calls.map((c) => [c.message.messageIdSeed, c.connection.password]));
    expect(byTo.get(a.id)).toBe(PASSWORD_A);
    expect(byTo.get(b.id)).toBe(PASSWORD_B);

    await rawPrisma.projectFeature.updateMany({ where: { projectId: B, key: "CLIENT_CENTER" }, data: { enabled: false } });
    resetProjectFeatureCacheForTests();
    const b2 = await queue(B);
    await runEmailOutboxTick(new Date(Date.now() + 120_000), send, publicHost);
    expect((await row(b2.id)).status).toBe("QUEUED");
    await rawPrisma.projectFeature.updateMany({ where: { projectId: B, key: "CLIENT_CENTER" }, data: { enabled: true } });
    resetProjectFeatureCacheForTests();
  });

  it("does not see another project's queued message", async () => {
    await settingsFor(A, PASSWORD_A);
    await queue(B);
    expect(await inA(() => sendNextQueued(new Date(), send, publicHost))).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses an idempotency key used twice in one project", async () => {
    await queue(A, { idempotencyKey: "same" });
    await expect(queue(A, { idempotencyKey: "same" })).rejects.toThrow();
    await queue(B, { idempotencyKey: "same" });
  });

  it("makes the database refuse to move a row to another project", async () => {
    const m = await queue(A);
    await expect(rawPrisma.emailOutbox.update({ where: { id: m.id }, data: { projectId: B } })).rejects.toThrow();
    void inB;
  });
});

describe("6. messages to clients (CLIENT_CRM_V7.md §6)", () => {
  async function clientMessage(projectId: string, consent: "UNKNOWN" | "OPTED_IN" | "OPTED_OUT", batch: boolean) {
    const client = await rawPrisma.client.create({ data: { projectId, code: `EM-${randomUUID().slice(0, 8)}`, name: "Mail Client" } });
    const address = `client-${randomUUID().slice(0, 8)}@example.test`;
    await rawPrisma.clientChannel.create({ data: { projectId, clientId: client.id, kind: "EMAIL", value: address, normalizedValue: address, consentStatus: consent } });
    const m = await queue(projectId, { purpose: "CLIENT_MESSAGE", toAddress: address });
    const batchRow = batch
      ? await rawPrisma.clientMessageBatch.create({ data: { projectId, templateVersion: 1, templateName: "T", status: "QUEUED", submittedById: "a", decidedById: "b", recipientCount: 1, eligibleCount: 1, skippedCount: 0 } })
      : null;
    await rawPrisma.clientMessage.create({ data: { projectId, clientId: client.id, batchId: batchRow?.id ?? null, channel: "EMAIL", status: "QUEUED", toAddress: address, subject: "S", body: "B", emailOutboxId: m.id } });
    return { message: m, clientId: client.id };
  }
  afterAll(async () => {
    await rawPrisma.clientMessage.deleteMany({ where: { projectId: { in: [A, B] } } });
    await rawPrisma.clientMessageBatch.deleteMany({ where: { projectId: { in: [A, B] } } });
    await rawPrisma.emailOutbox.deleteMany({ where: { projectId: { in: [A, B] } } });
    await rawPrisma.clientChannel.deleteMany({ where: { projectId: { in: [A, B] } } });
    await rawPrisma.client.deleteMany({ where: { projectId: { in: [A, B] } } });
  });

  it("sends a client message only while the channel is ON and verified as it is now", async () => {
    await settingsFor(A, PASSWORD_A, { enabled: false, verifiedVersion: 1 });
    const off = await clientMessage(A, "UNKNOWN", false);
    await inA(() => sendNextQueued(new Date(), send, publicHost));
    expect(fake.calls).toHaveLength(0);
    expect(await row(off.message.id)).toMatchObject({ status: "FAILED" });
    expect((await row(off.message.id)).lastError).toMatch(/switched off/);

    await settingsFor(A, PASSWORD_A, { enabled: true, settingsVersion: 2, verifiedVersion: 1 });
    const unverified = await clientMessage(A, "UNKNOWN", false);
    await inA(() => sendNextQueued(new Date(), send, publicHost));
    expect(fake.calls).toHaveLength(0);
    expect((await row(unverified.message.id)).lastError).toMatch(/not been tested again/);

    await settingsFor(A, PASSWORD_A, { enabled: true, verifiedVersion: 1 });
    const ok = await clientMessage(A, "UNKNOWN", false);
    await inA(() => sendNextQueued(new Date(), send, publicHost));
    expect(fake.calls).toHaveLength(1);
    expect(await row(ok.message.id)).toMatchObject({ status: "ACCEPTED" });
    // A client message never touches the channel's verification (only a TEST does).
    expect((await settingsOf(A)).lastTestOk).toBeNull();
  });

  it("never sends to a client who opted out after it was queued; a bulk message still needs recorded consent", async () => {
    await settingsFor(A, PASSWORD_A, { enabled: true, verifiedVersion: 1 });
    const opted = await clientMessage(A, "OPTED_IN", false);
    await rawPrisma.clientChannel.updateMany({ where: { clientId: opted.clientId }, data: { consentStatus: "OPTED_OUT" } });
    await inA(() => sendNextQueued(new Date(), send, publicHost));
    expect((await row(opted.message.id)).lastError).toMatch(/opted out/);

    const bulk = await clientMessage(A, "UNKNOWN", true);
    await inA(() => sendNextQueued(new Date(), send, publicHost));
    expect((await row(bulk.message.id)).lastError).toMatch(/consent/);
    expect(fake.calls).toHaveLength(0);
  });
});
