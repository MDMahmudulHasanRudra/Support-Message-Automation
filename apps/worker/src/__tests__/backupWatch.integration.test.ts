import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { BACKUP_ALERT_MAX_ATTEMPTS } from "@support-automation/shared";
import { rawPrisma } from "./helpers/projectFixtures.js";
import { BACKUP_ALERT_SENDING_STUCK_MS, checkBackupHealth, type BackupWatchDeps } from "../health/backupWatch.js";
import type { SmtpMessage, SmtpOutcome, SmtpSender } from "../email/smtpTransport.js";

/**
 * Backup alerts (docs/get-assist-ultimate/19 §7) against a FAKE mail server, scripted per recipient.
 *   - The newest run and the newest success decide; nothing is alerted before a first run.
 *   - One logical alert per outage per kind; one delivery per recipient, never sent twice once SENT.
 *   - Only a CONFIRMED non-delivery is retried (refusal, no platform email, refused host), on a bounded
 *     schedule; an UNKNOWN outcome, a thrown send or an interrupted send is never resent.
 *   - A partial success stays partial: only the recipient that failed is retried.
 *   - A new success ends the outage, and the old alert's retries stop.
 *   - No path or credential in the email; a stored error is redacted.
 */

const tag = randomUUID().slice(0, 8);
const NOW = new Date();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const minutesLater = (m: number) => new Date(NOW.getTime() + m * 60_000);
const ours = { active: `ops-${tag}@example.test`, second: `ops2-${tag}@example.test`, inactive: `old-${tag}@example.test` };
const operatorIds: string[] = [];

let sent: SmtpMessage[] = [];
/** Per recipient, outcomes to return in order ("throw" throws); empty = accepted. */
let script = new Map<string, Array<SmtpOutcome | "throw">>();
const send: SmtpSender = async (_connection, message) => {
  sent.push(message);
  const next = script.get(message.to)?.shift();
  if (next === "throw") throw new Error("socket hang up");
  return next ?? { ok: true, providerMessageId: `<${message.messageIdSeed}@fake>` };
};
const refusedFor = (message = "550 mailbox unavailable") => ({ ok: false as const, failure: { kind: "PERMANENT" as const, message } });
const unknownFor = () => ({ ok: false as const, failure: { kind: "UNKNOWN" as const, message: "connection closed after DATA" } });

const deps = (mailer = true, resolve: BackupWatchDeps["resolve"] = async () => ["203.0.113.10"]): BackupWatchDeps => ({
  mailer: mailer ? { connection: { host: "smtp.example.test", port: 587, tlsMode: "STARTTLS", username: "u", password: "p" }, fromAddress: "platform@example.test", fromName: "Platform" } : null,
  send,
  resolve,
});
const toOurs = (address?: string) => sent.filter((m) => (address ? m.to === address : m.to === ours.active || m.to === ours.second || m.to === ours.inactive));

async function runRow(status: "SUCCEEDED" | "FAILED", finishedAt: Date, reason: string | null = null) {
  return rawPrisma.backupRun.create({ data: { status, startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt, reason } });
}
const delivery = (recipient: string) => rawPrisma.backupAlertDelivery.findFirstOrThrow({ where: { recipient } });

beforeAll(async () => {
  for (const [key, email] of Object.entries(ours)) {
    const op = await rawPrisma.platformOperator.create({ data: { username: `bw_${key}_${tag}`, name: key, email, passwordHash: "x", isActive: key !== "inactive" } });
    operatorIds.push(op.id);
  }
});

beforeEach(async () => {
  sent = [];
  script = new Map();
  await rawPrisma.backupAlert.deleteMany({});
  await rawPrisma.backupRun.deleteMany({});
});

afterAll(async () => {
  await rawPrisma.backupAlert.deleteMany({});
  await rawPrisma.backupRun.deleteMany({});
  await rawPrisma.platformOperator.deleteMany({ where: { id: { in: operatorIds } } });
  await rawPrisma.$disconnect();
});

describe("what is alerted", () => {
  it("nothing before a first run is recorded", async () => {
    expect(await checkBackupHealth(NOW, 26, deps())).toMatchObject({ alert: "none", health: { state: "NONE" } });
    expect(sent).toHaveLength(0);
  });

  it("a failed run emails every active operator once, without paths or credentials; a second check sends nothing", async () => {
    await runRow("SUCCEEDED", hoursAgo(20));
    await runRow("FAILED", hoursAgo(1), "only 12 MB free in /home/rudra/backups/get-assist, need 900 MB. password=hunter2");
    expect(await checkBackupHealth(NOW, 26, deps())).toMatchObject({ alert: "sent", recipients: 2 });
    expect(toOurs().map((m) => m.to).sort()).toEqual([ours.active, ours.second].sort());
    const mail = toOurs(ours.active)[0]!;
    expect(mail.subject).toBe("Backup failed");
    expect(mail.text).toContain("only 12 MB free in [path]");
    expect(mail.text).not.toMatch(/home\/rudra|hunter2|backups\/get-assist/);

    sent = [];
    await runRow("FAILED", hoursAgo(0.5), "again");
    expect((await checkBackupHealth(minutesLater(60), 26, deps())).alert).toBe("already-sent");
    expect(sent).toHaveLength(0);
    expect(await rawPrisma.backupAlert.count()).toBe(1);
  });

  it("a success after an outage opens a new alert for the next failure", async () => {
    await runRow("SUCCEEDED", hoursAgo(30));
    await runRow("FAILED", hoursAgo(5));
    expect((await checkBackupHealth(NOW, 26, deps())).alert).toBe("sent");
    await runRow("SUCCEEDED", hoursAgo(4));
    expect((await checkBackupHealth(NOW, 26, deps())).alert).toBe("none");
    await runRow("FAILED", hoursAgo(1));
    expect((await checkBackupHealth(NOW, 26, deps())).alert).toBe("sent");
    expect(await rawPrisma.backupAlert.count()).toBe(2);
  });

  it("alerts once when the last success is stale", async () => {
    await runRow("SUCCEEDED", hoursAgo(30));
    expect(await checkBackupHealth(NOW, 26, deps())).toMatchObject({ alert: "sent", health: { state: "STALE" } });
    expect(toOurs(ours.active)[0]?.subject).toBe("Backups are out of date");
    expect((await checkBackupHealth(minutesLater(30), 26, deps())).alert).toBe("already-sent");
  });
});

describe("delivery that did not happen is retried — only when it certainly did not happen", () => {
  it("no platform email: not delivered, waits for the backoff, then delivers once email is set up", async () => {
    await runRow("FAILED", hoursAgo(1));
    expect((await checkBackupHealth(NOW, 26, deps(false))).alert).toBe("not-delivered");
    expect(await rawPrisma.backupAlert.findFirstOrThrow()).toMatchObject({ delivered: false, recipients: 0, note: "Platform email is not configured.", attempts: 1 });
    // Inside the backoff nothing is tried, even with email now working.
    expect((await checkBackupHealth(minutesLater(1), 26, deps())).alert).toBe("waiting");
    expect(sent).toHaveLength(0);
    // After it, the same alert is delivered.
    expect(await checkBackupHealth(minutesLater(6), 26, deps())).toMatchObject({ alert: "sent", recipients: 2 });
    expect(await rawPrisma.backupAlert.findFirstOrThrow()).toMatchObject({ delivered: true, recipients: 2 });
    expect(await rawPrisma.backupAlert.count()).toBe(1);
  });

  it("a partial success retries only the refused recipient, and never sends twice to the one that got it", async () => {
    await runRow("FAILED", hoursAgo(1));
    script.set(ours.second, [refusedFor()]);
    expect(await checkBackupHealth(NOW, 26, deps())).toMatchObject({ alert: "sent", recipients: 1 });
    expect(await delivery(ours.second)).toMatchObject({ status: "FAILED", attempts: 1 });
    expect((await checkBackupHealth(minutesLater(1), 26, deps())).alert).toBe("waiting");
    expect(await checkBackupHealth(minutesLater(6), 26, deps())).toMatchObject({ alert: "sent", recipients: 1 });
    expect(toOurs(ours.active)).toHaveLength(1);
    expect(toOurs(ours.second)).toHaveLength(2);
    expect(await delivery(ours.second)).toMatchObject({ status: "SENT", attempts: 2 });
    expect((await checkBackupHealth(minutesLater(600), 26, deps())).alert).toBe("already-sent");
    expect(toOurs()).toHaveLength(3);
  });

  it("an UNKNOWN outcome or a thrown send is never resent", async () => {
    await runRow("FAILED", hoursAgo(1));
    script.set(ours.active, [unknownFor()]);
    script.set(ours.second, ["throw"]);
    expect((await checkBackupHealth(NOW, 26, deps())).alert).toBe("already-sent");
    for (const later of [6, 30, 120, 600]) await checkBackupHealth(minutesLater(later), 26, deps());
    expect(toOurs(ours.active)).toHaveLength(1);
    expect(toOurs(ours.second)).toHaveLength(1);
    expect((await delivery(ours.active)).status).toBe("UNKNOWN");
    expect((await delivery(ours.second)).status).toBe("UNKNOWN");
  });

  it("a send interrupted by a stopped worker (left SENDING) becomes UNKNOWN and is never resent", async () => {
    await runRow("FAILED", hoursAgo(1));
    await checkBackupHealth(NOW, 26, deps());
    await rawPrisma.backupAlertDelivery.updateMany({ where: { recipient: ours.second }, data: { status: "SENDING", sendingAt: NOW } });
    sent = [];
    await checkBackupHealth(new Date(NOW.getTime() + BACKUP_ALERT_SENDING_STUCK_MS + 60_000), 26, deps());
    expect((await delivery(ours.second)).status).toBe("UNKNOWN");
    expect(toOurs(ours.second)).toHaveLength(0);
  });

  it("retries are bounded: a recipient always refused is tried exactly the maximum number of times", async () => {
    await runRow("FAILED", hoursAgo(1));
    script.set(ours.active, Array.from({ length: 20 }, () => refusedFor()));
    let at = NOW;
    for (let i = 0; i < 12; i++) {
      await checkBackupHealth(at, 26, deps());
      at = new Date(at.getTime() + 7 * 60 * 60_000); // past the longest backoff each time
    }
    expect(toOurs(ours.active)).toHaveLength(BACKUP_ALERT_MAX_ATTEMPTS);
    expect(await delivery(ours.active)).toMatchObject({ status: "FAILED", attempts: BACKUP_ALERT_MAX_ATTEMPTS, nextAttemptAt: null });
  });

  it("a refused mail host is a confirmed non-delivery: nothing is sent, a retry is scheduled", async () => {
    await runRow("FAILED", hoursAgo(1));
    const resolveToLocal: BackupWatchDeps["resolve"] = async () => ["127.0.0.1"];
    expect((await checkBackupHealth(NOW, 26, deps(true, resolveToLocal))).alert).toBe("not-delivered");
    expect(sent).toHaveLength(0);
    expect(await delivery(ours.active)).toMatchObject({ status: "FAILED", attempts: 1 });
    expect((await checkBackupHealth(minutesLater(6), 26, deps())).alert).toBe("sent");
  });

  it("once a backup succeeds, the old alert's pending retries stop", async () => {
    await runRow("FAILED", hoursAgo(2));
    script.set(ours.active, [refusedFor()]);
    await checkBackupHealth(NOW, 26, deps());
    await runRow("SUCCEEDED", hoursAgo(1));
    sent = [];
    expect((await checkBackupHealth(minutesLater(10), 26, deps())).alert).toBe("none");
    expect(sent).toHaveLength(0);
  });

  it("a stored delivery error is redacted", async () => {
    await runRow("FAILED", hoursAgo(1));
    script.set(ours.active, [refusedFor(`550 5.1.1 <${ours.active}> rejected for 8801711000222@c.us`)]);
    await checkBackupHealth(NOW, 26, deps());
    const { lastError } = await delivery(ours.active);
    expect(lastError).not.toContain(ours.active);
    expect(lastError).not.toContain("8801711000222");
  });
});
