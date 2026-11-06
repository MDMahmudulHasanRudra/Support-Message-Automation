import "./helpers/requireTestDatabase.js";
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PLATFORM_LOG_CUSTOMER } from "@support-automation/db";
import { rawPrisma } from "./helpers/projectFixtures.js";
import { parseSystemLogRetention, pruneSystemLog } from "../health/systemLogRetention.js";

/**
 * System Log retention: off unless a valid period is set; when set, removes only entries older than it, and
 * never a support-access entry or a platform entry. Rows are dated in 1990 so nothing another suite wrote can
 * be older; every assertion is about this file's own rows.
 */

const tag = randomUUID().slice(0, 8);
const created: string[] = [];

async function entry(createdAt: Date, extra: { scope?: string; customerId?: string | null } = {}) {
  const row = await rawPrisma.systemLog.create({
    data: { level: "INFO", scope: extra.scope ?? "queue", message: `retention ${tag}`, createdAt, customerId: extra.customerId ?? null },
    select: { id: true },
  });
  created.push(row.id);
  return row.id;
}

afterAll(async () => {
  await rawPrisma.systemLog.deleteMany({ where: { id: { in: created } } });
  await rawPrisma.$disconnect();
});

describe("parseSystemLogRetention", () => {
  it("keeps everything unless a whole number of at least 30 days is set", () => {
    expect(parseSystemLogRetention(undefined)).toEqual({ enabled: false });
    expect(parseSystemLogRetention("")).toEqual({ enabled: false });
    expect(parseSystemLogRetention("0")).toEqual({ enabled: false });
    expect(parseSystemLogRetention("7").enabled).toBe(false);
    expect(parseSystemLogRetention("90 days").enabled).toBe(false);
    expect(parseSystemLogRetention("-30").enabled).toBe(false);
    expect(parseSystemLogRetention(" 90 ")).toEqual({ enabled: true, days: 90 });
  });
});

describe("pruneSystemLog", () => {
  it("does nothing while retention is off", async () => {
    const old = await entry(new Date("1990-01-01T00:00:00Z"));
    expect(await pruneSystemLog({ enabled: false })).toBe(0);
    expect(await rawPrisma.systemLog.count({ where: { id: old } })).toBe(1);
  });

  it("removes old entries and keeps recent, support-access and platform ones", async () => {
    const now = new Date();
    const old = await entry(new Date("1990-01-01T00:00:00Z"));
    const recent = await entry(new Date(now.getTime() - 5 * 24 * 60 * 60_000));
    const support = await entry(new Date("1990-01-01T00:00:00Z"), { scope: "support" });
    const platform = await entry(new Date("1990-01-01T00:00:00Z"), { customerId: PLATFORM_LOG_CUSTOMER });
    const customer = await entry(new Date("1990-01-01T00:00:00Z"), { customerId: `cust-${tag}` });
    await pruneSystemLog({ enabled: true, days: 30 }, now);
    const left = new Set((await rawPrisma.systemLog.findMany({ where: { id: { in: [old, recent, support, platform, customer] } }, select: { id: true } })).map((r) => r.id));
    expect(left.has(old)).toBe(false);
    expect(left.has(customer)).toBe(false);
    expect(left.has(recent)).toBe(true);
    expect(left.has(support)).toBe(true);
    expect(left.has(platform)).toBe(true);
  });
});
