import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, encryptSecret } from "@support-automation/db";
import { rawPrisma } from "./helpers/projectFixtures.js";
import { platformMailerFromEnv, runBillingTick, sendInvitations, type BillingDeps } from "../billing/billingProcessor.js";
import type { SmtpMessage } from "../email/smtpTransport.js";

/**
 * The SaaS billing loop (SAAS_PLATFORM_PLAN.md §10): the hold follows the subscription, a customer
 * with no subscription is never touched (Customer #1), each reminder happens once however many ticks
 * run, nothing is emailed without platform SMTP, and an invitation is emailed once and its link forgotten.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const DAY = 24 * 60 * 60_000;
const projects: string[] = [];
const customers: string[] = [];
let creatorId = "";

async function customerWithWorkspace(key: string) {
  const p = await createProjectWithDefaults({ name: `Bill ${key} ${tag}`, slug: `bill-${key}-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma);
  projects.push(p.id);
  const c = await rawPrisma.customer.create({ data: { name: `Bill ${key} ${tag}`, contactEmail: `${key}-${tag}@example.test` } });
  customers.push(c.id);
  await rawPrisma.project.update({ where: { id: p.id }, data: { customerId: c.id } });
  return { projectId: p.id, customerId: c.id };
}

function subscription(customerId: string, data: { paidThrough: Date; autoEnforce: boolean }) {
  return rawPrisma.subscription.create({
    data: { customerId, planName: "Standard", priceMinor: BigInt(150000), currency: "BDT", interval: "MONTH", startsAt: new Date(Date.now() - 90 * DAY), graceDays: 7, ...data },
  });
}

function mailer(sent: SmtpMessage[]): BillingDeps {
  return {
    mailer: platformMailerFromEnv({ PLATFORM_SMTP_HOST: "smtp.example.test", PLATFORM_SMTP_FROM_ADDRESS: "billing@example.test" }),
    send: async (_c, m) => {
      sent.push(m);
      return { ok: true, providerMessageId: `<${m.messageIdSeed}>` };
    },
    resolve: async () => ["203.0.113.25"],
  };
}
const noMail: BillingDeps = {
  mailer: null,
  send: async () => {
    throw new Error("must not send");
  },
  resolve: async () => [],
};
const held = async (projectId: string) => (await rawPrisma.project.findUniqueOrThrow({ where: { id: projectId } })).billingHoldAt !== null;

beforeAll(async () => {
  creatorId = (await rawPrisma.user.create({ data: { username: `billcreator_${tag}`, email: `billcreator_${tag}@example.test`, name: "C", passwordHash: "x" } })).id;
});

afterAll(async () => {
  await rawPrisma.project.updateMany({ where: { id: { in: projects } }, data: { customerId: null, status: "ARCHIVED", billingHoldAt: null } });
  await rawPrisma.customer.deleteMany({ where: { id: { in: customers } } });
  await rawPrisma.projectAccess.deleteMany({ where: { projectId: { in: projects } } });
  await rawPrisma.user.deleteMany({ where: { id: creatorId } });
  await rawPrisma.$disconnect();
});

describe("the billing loop", () => {
  it("holds an enforced lapsed workspace, never one without a subscription or without enforcement", async () => {
    const none = await customerWithWorkspace("none");
    const lenient = await customerWithWorkspace("lenient");
    const strict = await customerWithWorkspace("strict");
    await subscription(lenient.customerId, { paidThrough: new Date(Date.now() - 60 * DAY), autoEnforce: false });
    await subscription(strict.customerId, { paidThrough: new Date(Date.now() - 60 * DAY), autoEnforce: true });

    await runBillingTick(new Date(), noMail);
    expect(await held(none.projectId)).toBe(false);
    expect(await held(lenient.projectId)).toBe(false);
    expect(await held(strict.projectId)).toBe(true);
    expect(await rawPrisma.subscriptionEvent.count({ where: { customerId: none.customerId } })).toBe(0);
  });

  it("records each reminder once, and emails it only when platform email is configured", async () => {
    const soon = await customerWithWorkspace("soon");
    await subscription(soon.customerId, { paidThrough: new Date(Date.now() + 2.5 * DAY), autoEnforce: true });

    await runBillingTick(new Date(), noMail);
    const first = await rawPrisma.subscriptionEvent.findMany({ where: { customerId: soon.customerId, kind: { startsWith: "REMINDER_" } } });
    expect(first).toHaveLength(1);
    expect(first[0]!.detail).toMatchObject({ daysBefore: 3, email: "not configured" });

    const sent: SmtpMessage[] = [];
    for (let i = 0; i < 3; i++) await runBillingTick(new Date(), mailer(sent));
    expect(await rawPrisma.subscriptionEvent.count({ where: { customerId: soon.customerId, kind: { startsWith: "REMINDER_" } } })).toBe(1);
    expect(sent.filter((m) => m.to === `soon-${tag}@example.test`)).toHaveLength(0); // the 3-day reminder was already recorded

    // The next reminder day (1 day before) is a new reminder: sent once, to the contact.
    for (let i = 0; i < 3; i++) await runBillingTick(new Date(Date.now() + 2 * DAY), mailer(sent));
    const mine = sent.filter((m) => m.to === `soon-${tag}@example.test`);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toMatch(/renews/);
  });

  it("emails an invitation once, then forgets the link; without email it stays for copying by hand", async () => {
    const owner = await customerWithWorkspace("owner");
    const link = `https://example.test/invite/${randomUUID()}`;
    const inv = await rawPrisma.userInvitation.create({
      data: {
        customerId: owner.customerId,
        projectId: owner.projectId,
        name: "Owner",
        email: `boss-${tag}@example.test`,
        tokenHash: randomUUID(),
        linkCiphertext: encryptSecret(link),
        expiresAt: new Date(Date.now() + 3 * DAY),
      },
    });
    await runBillingTick(new Date(), noMail);
    expect((await rawPrisma.userInvitation.findUniqueOrThrow({ where: { id: inv.id } })).emailedAt).toBeNull();

    const sent: SmtpMessage[] = [];
    // Two senders racing over the same invitation: the claim lets exactly one send it.
    await Promise.all([sendInvitations(new Date(), mailer(sent)), sendInvitations(new Date(), mailer(sent)), sendInvitations(new Date(), mailer(sent))]);
    const invites = sent.filter((m) => m.to === `boss-${tag}@example.test`);
    expect(invites).toHaveLength(1);
    expect(invites[0]!.text).toContain(link);
    const after = await rawPrisma.userInvitation.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.emailedAt).not.toBeNull();
    expect(after.linkCiphertext).toBeNull();
  });
});
