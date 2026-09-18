import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Prisma, prisma } from "@support-automation/db";
import type { WhatsAppAccount } from "@prisma/client";
import { getGlobalRateLimitUsage, getPerClientLimitUsage } from "../queue/rateLimiter.js";

/**
 * Every query the performance work rewrote, checked against the one it replaced.
 *
 * The rule for that work was that nothing may change what a number MEANS — only how it is
 * fetched. That is easy to say and easy to get wrong in exactly the ways that do not announce
 * themselves: a LATERAL that silently drops a group with no messages, a `date_trunc` that buckets
 * a Dhaka morning under the previous day, a conditional aggregate that counts a boundary row
 * differently from the `COUNT(*)` it replaced.
 *
 * So each test here runs the OLD form and the NEW form against the same seeded rows and asserts
 * they agree. The old form is spelled out inline rather than imported, precisely because it no
 * longer exists in the codebase — that is the point of keeping it here.
 */

let account: WhatsAppAccount;
const groupIds: string[] = [];

const CHAT = (n: number) => `qr-${n}-${randomUUID()}@g.us`;

beforeAll(async () => {
  account = await prisma.whatsAppAccount.create({
    data: { label: `Query Rewrite ${randomUUID()}`, status: "CONNECTED" },
  });

  // Three groups, covering the cases a LATERAL can get wrong: one waiting on a customer, one
  // already answered, and one with no messages at all.
  for (const [index, spec] of [
    { monitored: true, messages: ["IN"] },
    { monitored: true, messages: ["IN", "OUT"] },
    { monitored: true, messages: [] as string[] },
    // Unmonitored, so it must never appear however loud it is.
    { monitored: false, messages: ["IN"] },
  ].entries()) {
    const group = await prisma.whatsAppGroup.create({
      data: {
        accountId: account.id,
        whatsappGroupId: CHAT(index),
        name: `Rewrite Group ${index}`,
        isActive: true,
        isMonitored: spec.monitored,
      },
    });
    groupIds.push(group.id);

    for (const [messageIndex, direction] of spec.messages.entries()) {
      await prisma.message.create({
        data: {
          accountId: account.id,
          groupId: group.id,
          whatsappMessageId: `qrm-${randomUUID()}`,
          chatId: group.whatsappGroupId,
          senderPhone: "8801888888888",
          direction: direction === "IN" ? "INCOMING" : "OUTGOING",
          isFromTeamMember: false,
          body: `message ${messageIndex}`,
          normalizedBody: `message ${messageIndex}`,
          // Distinct instants, so "newest" is unambiguous and neither form has to break a tie.
          timestampWa: new Date(Date.now() - (10 - messageIndex) * 60_000),
          processingStatus: "PROCESSED",
        },
      });
    }
  }
});

afterAll(async () => {
  await prisma.message.deleteMany({ where: { accountId: account.id } });
  await prisma.outboundMessage.deleteMany({ where: { accountId: account.id } });
  await prisma.supportActivity.deleteMany({ where: { accountId: account.id } });
  await prisma.whatsAppGroup.deleteMany({ where: { accountId: account.id } });
  await prisma.whatsAppAccount.delete({ where: { id: account.id } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("awaiting-reply: DISTINCT ON over every message vs a LATERAL over the groups", () => {
  it("returns the same rows", async () => {
    const ids = Prisma.join(groupIds);

    // The old form: a DISTINCT ON over the whole Message table, filtering monitored/active after.
    const before = await prisma.$queryRaw<Array<{ groupId: string; ts: Date }>>`
      WITH latest AS (
        SELECT DISTINCT ON (m."groupId")
          m."groupId" AS group_id, m."timestampWa" AS ts,
          m."direction" AS direction, m."isFromTeamMember" AS from_team
        FROM "Message" m
        WHERE m."groupId" IS NOT NULL
        ORDER BY m."groupId", m."timestampWa" DESC
      )
      SELECT g."id" AS "groupId", l.ts AS ts
      FROM latest l
      JOIN "WhatsAppGroup" g ON g."id" = l.group_id
      WHERE g."isMonitored" = true AND g."isActive" = true
        AND l.direction = 'INCOMING' AND l.from_team = false
        AND g."id" IN (${ids})
      ORDER BY l.ts ASC
    `;

    const after = await prisma.$queryRaw<Array<{ groupId: string; ts: Date }>>`
      SELECT g."id" AS "groupId", l.ts AS ts
      FROM "WhatsAppGroup" g
      CROSS JOIN LATERAL (
        SELECT m."timestampWa" AS ts, m."direction" AS direction, m."isFromTeamMember" AS from_team
        FROM "Message" m
        WHERE m."groupId" = g."id"
        ORDER BY m."timestampWa" DESC
        LIMIT 1
      ) l
      WHERE g."isMonitored" = true AND g."isActive" = true
        AND l.direction = 'INCOMING' AND l.from_team = false
        AND g."id" IN (${ids})
      ORDER BY l.ts ASC
    `;

    expect(after).toEqual(before);
    // Positive assertion too, so a rewrite that returned nothing at all could not pass by matching
    // an equally empty old form.
    expect(after).toHaveLength(1);
    expect(after[0]!.groupId).toBe(groupIds[0]);
  });

  it("drops a group with no messages, exactly as the JOIN did", async () => {
    // CROSS JOIN LATERAL produces no row when the subquery is empty, which is the same behaviour
    // as the inner JOIN to `latest`. A LEFT JOIN LATERAL here would have quietly introduced every
    // silent group into the waiting list with a null timestamp.
    const rows = await prisma.$queryRaw<Array<{ groupId: string }>>`
      SELECT g."id" AS "groupId"
      FROM "WhatsAppGroup" g
      CROSS JOIN LATERAL (
        SELECT m."timestampWa" FROM "Message" m WHERE m."groupId" = g."id"
        ORDER BY m."timestampWa" DESC LIMIT 1
      ) l
      WHERE g."id" = ${groupIds[2]}
    `;
    expect(rows).toHaveLength(0);
  });
});

describe("chat inbox: DISTINCT ON vs a LATERAL, over the same listed groups", () => {
  it("returns the same newest message per group", async () => {
    const ids = Prisma.join(groupIds);

    const before = await prisma.$queryRaw<Array<{ groupId: string; body: string; direction: string }>>`
      SELECT DISTINCT ON (m."groupId") m."groupId", m."body", m."direction"::text AS direction
      FROM "Message" m
      WHERE m."groupId" IN (${ids})
      ORDER BY m."groupId", m."timestampWa" DESC
    `;

    const after = await prisma.$queryRaw<Array<{ groupId: string; body: string; direction: string }>>`
      SELECT g."id" AS "groupId", l."body", l."direction"::text AS direction
      FROM "WhatsAppGroup" g
      CROSS JOIN LATERAL (
        SELECT m."body", m."timestampWa", m."direction"
        FROM "Message" m WHERE m."groupId" = g."id"
        ORDER BY m."timestampWa" DESC LIMIT 1
      ) l
      WHERE g."id" IN (${ids})
    `;

    const sort = (rows: typeof before) => [...rows].sort((a, b) => a.groupId.localeCompare(b.groupId));
    expect(sort(after)).toEqual(sort(before));
    expect(after.length).toBeGreaterThan(0);
  });
});

describe("Dhaka day bucketing", () => {
  it("puts a Dhaka morning on the right day — which the single-argument form does not", async () => {
    // The trap this test exists for. `occurredAt` is `timestamp WITHOUT time zone` holding UTC, and
    // Postgres's two AT TIME ZONE overloads do OPPOSITE things: on a timestamptz it converts, on a
    // plain timestamp it interprets. So the single-argument form reads a UTC instant as though it
    // were already Dhaka local and shifts it six hours the wrong way — moving every message sent
    // before noon Dhaka onto the previous day.
    const morningInDhaka = new Date("2026-09-18T02:00:00.000Z"); // 08:00 Dhaka on the 18th

    const [row] = await prisma.$queryRaw<Array<{ wrong: string; right: string }>>`
      SELECT
        to_char(date_trunc('day', ${morningInDhaka}::timestamp AT TIME ZONE 'Asia/Dhaka'), 'YYYY-MM-DD') AS wrong,
        to_char(date_trunc('day', ${morningInDhaka}::timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka'), 'YYYY-MM-DD') AS right
    `;

    expect(row!.right).toBe("2026-09-18");
    expect(row!.wrong).toBe("2026-09-17");
  });
});

describe("rate limits: five COUNTs vs two conditional aggregates", () => {
  const MINUTE_MS = 60_000;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;

  beforeAll(async () => {
    // One row inside each window, plus one outside the widest — the boundary case a conditional
    // aggregate is most likely to count differently from a bare COUNT(*).
    for (const agoMs of [30_000, 30 * MINUTE_MS, 6 * HOUR_MS, 30 * HOUR_MS]) {
      await prisma.outboundMessage.create({
        data: {
          accountId: account.id,
          chatId: "rl@g.us",
          toPhone: "8801777777777",
          body: "x",
          actionType: "AUTO_REPLY",
          status: "SENT",
          sentAt: new Date(Date.now() - agoMs),
          idempotencyKey: `rl-${randomUUID()}`,
        },
      });
    }
  });

  const countSentOldWay = (sinceMs: number, toPhone?: string) =>
    prisma.outboundMessage.count({
      where: {
        accountId: account.id,
        status: "SENT",
        sentAt: { gte: new Date(Date.now() - sinceMs) },
        ...(toPhone ? { toPhone } : {}),
      },
    });

  it("agrees with the per-window counts it replaced", async () => {
    const [perMinute, perHour, perDay] = await Promise.all([
      countSentOldWay(MINUTE_MS),
      countSentOldWay(HOUR_MS),
      countSentOldWay(DAY_MS),
    ]);

    expect(await getGlobalRateLimitUsage(account.id)).toEqual({ perMinute, perHour, perDay });
    // The fixture has to actually exercise the windows, or this asserts 0 === 0.
    expect(perMinute).toBe(1);
    expect(perHour).toBe(2);
    expect(perDay).toBe(3);
  });

  it("agrees per client, and still filters by the number", async () => {
    const [perHour, perDay] = await Promise.all([
      countSentOldWay(HOUR_MS, "8801777777777"),
      countSentOldWay(DAY_MS, "8801777777777"),
    ]);

    expect(await getPerClientLimitUsage(account.id, "8801777777777")).toEqual({ perHour, perDay });
    expect(await getPerClientLimitUsage(account.id, "8801000000000")).toEqual({ perHour: 0, perDay: 0 });
  });
});
