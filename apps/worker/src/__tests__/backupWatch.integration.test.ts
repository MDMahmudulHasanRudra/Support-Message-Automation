import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { rawPrisma } from "./helpers/projectFixtures.js";
import { checkBackupHealth, type BackupWatchDeps } from "../health/backupWatch.js";
import type { SmtpMessage, SmtpSender } from "../email/smtpTransport.js";

/**
 * Backup alerts (docs/get-assist-ultimate/19 §7) against a FAKE mail server: the newest run and the newest
 * success decide; an outage emails the active platform operators once per kind (claimed before sending, so a
 * second check sends nothing); a new success opens a new alert; nothing about paths or credentials is in the
 * email; without platform email the alert is recorded as not delivered and still not repeated.
 */

const tag = randomUUID().slice(0, 8);
const NOW = new Date();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const ours = { active: `ops-${tag}@example.test`, inactive: `old-${tag}@example.test` };
const operatorIds: string[] = [];
let sent: SmtpMessage[] = [];

const send: SmtpSender = async (_connection, message) => {
  sent.push(message);
  return { ok: true, providerMessageId: `<${message.messageIdSeed}@fake>` };
};
const deps = (mailer = true): BackupWatchDeps => ({
  mailer: mailer ? { connection: { host: "smtp.example.test", port: 587, tlsMode: "STARTTLS", username: "u", password: "p" }, fromAddress: "platform@example.test", fromName: "Platform" } : null,
  send,
  resolve: async () => ["203.0.113.10"],
});
const toOurs = () => sent.filter((m) => m.to === ours.active || m.to === ours.inactive);

async function runRow(status: "SUCCEEDED" | "FAILED", finishedAt: Date, reason: string | null = null) {
  return rawPrisma.backupRun.create({ data: { status, startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt, reason } });
}

beforeAll(async () => {
  for (const [key, email] of Object.entries(ours)) {
    const op = await rawPrisma.platformOperator.create({ data: { username: `bw_${key}_${tag}`, name: key, email, passwordHash: "x", isActive: key === "active" } });
    operatorIds.push(op.id);
  }
});

beforeEach(async () => {
  sent = [];
  await rawPrisma.backupAlert.deleteMany({});
  await rawPrisma.backupRun.deleteMany({});
});

afterAll(async () => {
  await rawPrisma.backupAlert.deleteMany({});
  await rawPrisma.backupRun.deleteMany({});
  await rawPrisma.platformOperator.deleteMany({ where: { id: { in: operatorIds } } });
  await rawPrisma.$disconnect();
});

describe("backup alerts", () => {
  it("say nothing before a first run is recorded", async () => {
    const result = await checkBackupHealth(NOW, 26, deps());
    expect(result).toMatchObject({ alert: "none", health: { state: "NONE" } });
    expect(sent).toHaveLength(0);
  });

  it("a failed run emails active operators once, without paths or credentials, and a second check sends nothing", async () => {
    await runRow("SUCCEEDED", hoursAgo(20));
    await runRow("FAILED", hoursAgo(1), "only 12 MB free in /home/rudra/backups/get-assist, need 900 MB. password=hunter2");
    const first = await checkBackupHealth(NOW, 26, deps());
    expect(first.alert).toBe("sent");
    expect(toOurs().map((m) => m.to)).toEqual([ours.active]);
    const mail = toOurs()[0]!;
    expect(mail.subject).toBe("Backup failed");
    expect(mail.text).toContain("only 12 MB free in [path]");
    expect(mail.text).not.toMatch(/home\/rudra|hunter2|backups\/get-assist/);

    sent = [];
    await runRow("FAILED", hoursAgo(0.5), "again");
    expect((await checkBackupHealth(NOW, 26, deps())).alert).toBe("already-sent");
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
    const result = await checkBackupHealth(NOW, 26, deps());
    expect(result).toMatchObject({ alert: "sent", health: { state: "STALE" } });
    expect(toOurs()[0]?.subject).toBe("Backups are out of date");
    expect((await checkBackupHealth(NOW, 26, deps())).alert).toBe("already-sent");
  });

  it("without platform email the alert is recorded as not delivered, and not retried every tick", async () => {
    await runRow("FAILED", hoursAgo(1));
    expect((await checkBackupHealth(NOW, 26, deps(false))).alert).toBe("not-delivered");
    const row = await rawPrisma.backupAlert.findFirstOrThrow();
    expect(row).toMatchObject({ delivered: false, recipients: 0, note: "Platform email is not configured." });
    expect((await checkBackupHealth(NOW, 26, deps(false))).alert).toBe("already-sent");
  });
});
