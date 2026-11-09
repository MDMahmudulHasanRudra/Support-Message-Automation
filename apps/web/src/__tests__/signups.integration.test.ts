import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { prisma as rawPrisma } from "@support-automation/db";

/**
 * Public sign-up (SIGNUP.md): nothing exists while it is off, the form never creates a customer, an operator's approval goes
 * through Add customer once, and the answers do not reveal who is already a customer.
 */

process.env.AI_CREDENTIALS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let operator: { username: string } | null = { username: "op" };

vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  headers: async () => new Headers({ "x-relqivo-host": "localhost", "x-forwarded-for": address }),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
let address = "10.0.0.1";
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/platform/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/platform/auth")>()),
  requireOperatorAction: async () => (operator ? { operator } : { denied: "No." }),
}));

const { submitSignup, verifySignup } = await import("@/server/platform/actions/publicSignup");
const ops = await import("@/server/platform/actions/signups");
const { hashSignupToken, issueSignupFormStamp, loadPublicPlans } = await import("@/server/platform/signups");
const { forgetHostScopes } = await import("@/server/hostScope");

let planId = "";
let n = 0;

function form(extra: Record<string, string> = {}) {
  n += 1;
  address = `10.0.${Math.floor(n / 200)}.${n % 200}`;
  const f = new FormData();
  const fields = { businessName: `Shop ${tag} ${n}`, ownerName: "Nusrat", email: `s${n}_${tag}@example.test`, slug: `s-${tag}-${n}`, planId, stamp: issueSignupFormStamp(Date.now() - 10_000), ...extra };
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return { f, email: fields.email };
}
const setOpen = (signupEnabled: boolean) => rawPrisma.platformBillingSettings.upsert({ where: { id: "default" }, create: { id: "default", signupEnabled }, update: { signupEnabled } });
const row = (email: string) => rawPrisma.signupRequest.findFirst({ where: { email } });

beforeAll(async () => {
  forgetHostScopes();
  planId = (await rawPrisma.plan.create({ data: { name: `Public ${tag}`, priceMinor: BigInt(150000), isPublic: true, trialDays: 14 } })).id;
});

beforeEach(async () => {
  operator = { username: "op" };
  await setOpen(true);
});

afterAll(async () => {
  await setOpen(false);
  const requests = await rawPrisma.signupRequest.findMany({ where: { email: { contains: tag } } });
  await rawPrisma.signupRequest.deleteMany({ where: { email: { contains: tag } } });
  for (const id of requests.flatMap((r) => (r.customerId ? [r.customerId] : []))) {
    const projects = await rawPrisma.project.findMany({ where: { customerId: id }, select: { id: true } });
    const tables = (await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`).map((t) => t.table_name);
    for (const p of projects) {
      for (let pass = 0; pass < 4; pass++) for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, p.id).catch(() => undefined);
      await rawPrisma.project.deleteMany({ where: { id: p.id } });
    }
    await rawPrisma.userInvitation.deleteMany({ where: { customerId: id } });
    await rawPrisma.subscriptionEvent.deleteMany({ where: { customerId: id } });
    await rawPrisma.subscription.deleteMany({ where: { customerId: id } });
    await rawPrisma.customerDomain.deleteMany({ where: { customerId: id } });
    await rawPrisma.permissionModule.deleteMany({ where: { customerId: id } });
    await rawPrisma.customer.deleteMany({ where: { id } });
  }
  await rawPrisma.plan.deleteMany({ where: { id: planId } });
});

async function waitingRequest() {
  const { f, email } = form();
  expect(await submitSignup({}, f)).toEqual({ sent: true });
  const created = (await row(email))!;
  // The token is never stored, so the test swaps in one it knows.
  const token = `t-${randomUUID()}`;
  await rawPrisma.signupRequest.update({ where: { id: created.id }, data: { verifyTokenHash: hashSignupToken(token) } });
  expect(await verifySignup(token)).toBe("VERIFIED");
  return { id: created.id, email, slug: created.slug };
}

describe("while it is off", () => {
  it("the pages do not exist and the form refuses", async () => {
    await setOpen(false);
    expect(await loadPublicPlans()).toBeNull();
    const { f, email } = form();
    expect(await submitSignup({}, f)).toEqual({ error: expect.stringContaining("closed") });
    expect(await row(email)).toBeNull();
  });
});

describe("the form", () => {
  it("records a request, makes no customer, and keeps no readable link", async () => {
    const customers = await rawPrisma.customer.count();
    const { f, email } = form();
    expect(await submitSignup({}, f)).toEqual({ sent: true });
    const saved = (await row(email))!;
    expect(saved.status).toBe("EMAIL_PENDING");
    expect(saved.emailCiphertext).not.toContain("/signup/verify/");
    expect(await rawPrisma.customer.count()).toBe(customers);
  });

  it("only shows plans marked public", async () => {
    const hidden = await rawPrisma.plan.create({ data: { name: `Hidden ${tag}`, priceMinor: BigInt(1) } });
    expect((await loadPublicPlans())!.map((p) => p.id)).toContain(planId);
    expect((await loadPublicPlans())!.map((p) => p.id)).not.toContain(hidden.id);
    const { f } = form({ planId: hidden.id });
    expect((await submitSignup({}, f)).fieldErrors?.planId).toBeDefined();
    await rawPrisma.plan.delete({ where: { id: hidden.id } });
  });

  it("robots are told it worked and nothing is kept", async () => {
    const trap = form({ website: "http://spam.example" });
    expect(await submitSignup({}, trap.f)).toEqual({ sent: true });
    expect(await row(trap.email)).toBeNull();
    const instant = form({ stamp: issueSignupFormStamp() });
    expect(await submitSignup({}, instant.f)).toEqual({ sent: true });
    expect(await row(instant.email)).toBeNull();
    const forged = form({ stamp: `${Date.now() - 10_000}.forged` });
    await submitSignup({}, forged.f);
    expect(await row(forged.email)).toBeNull();
  });

  it("one open request per email, and the answer does not change", async () => {
    const first = form();
    await submitSignup({}, first.f);
    const again = form({ email: first.email, stamp: issueSignupFormStamp(Date.now() - 10_000) });
    expect(await submitSignup({}, again.f)).toEqual({ sent: true });
    expect(await rawPrisma.signupRequest.count({ where: { email: first.email } })).toBe(1);
  });

  it("too many from one connection are refused", async () => {
    const shared = "10.9.9.9";
    let last = {} as Awaited<ReturnType<typeof submitSignup>>;
    for (let i = 0; i < 10; i++) {
      const { f } = form();
      address = shared;
      last = await submitSignup({}, f);
    }
    expect(last.error).toContain("Too many");
  });
});

describe("confirming the email", () => {
  it("moves it to the operator, once", async () => {
    const { f, email } = form();
    await submitSignup({}, f);
    const created = (await row(email))!;
    const token = `t-${randomUUID()}`;
    await rawPrisma.signupRequest.update({ where: { id: created.id }, data: { verifyTokenHash: hashSignupToken(token) } });
    expect(await verifySignup(token)).toBe("VERIFIED");
    expect((await row(email))!.status).toBe("PENDING_APPROVAL");
    expect(await verifySignup(token)).toBe("ALREADY");
  });

  it("a wrong or expired link does nothing", async () => {
    expect(await verifySignup("nope")).toBe("INVALID");
    const { f, email } = form();
    await submitSignup({}, f);
    const created = (await row(email))!;
    const token = `t-${randomUUID()}`;
    await rawPrisma.signupRequest.update({ where: { id: created.id }, data: { verifyTokenHash: hashSignupToken(token), verifyExpiresAt: new Date(Date.now() - 1000) } });
    expect(await verifySignup(token)).toBe("INVALID");
    expect((await row(email))!.status).toBe("EMAIL_PENDING");
  });
});

describe("the operator", () => {
  const approve = (id: string, slug: string) => {
    const f = new FormData();
    f.set("slug", slug);
    f.set("planId", planId);
    return ops.approveSignup(id, {}, f);
  };

  it("nobody else can decide or switch it on", async () => {
    const request = await waitingRequest();
    operator = null;
    expect(await approve(request.id, request.slug)).toEqual({ error: "No." });
    expect(await ops.rejectSignup(request.id, "x")).toEqual({ error: "No." });
    expect(await ops.setSignupEnabled(true)).toEqual({ error: "No." });
    expect((await rawPrisma.signupRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe("PENDING_APPROVAL");
  });

  it("approving sets up the customer, plan, workspace and owner invitation", async () => {
    const request = await waitingRequest();
    const r = await approve(request.id, request.slug);
    expect(r.success).toBeDefined();
    const saved = await rawPrisma.signupRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(saved.status).toBe("APPROVED");
    const customerId = saved.customerId!;
    expect(await rawPrisma.subscription.findFirst({ where: { customerId, endedAt: null } })).toMatchObject({ planId, autoEnforce: false });
    expect((await rawPrisma.subscription.findFirstOrThrow({ where: { customerId, endedAt: null } })).trialEndsAt).not.toBeNull();
    expect(await rawPrisma.project.count({ where: { customerId, slug: request.slug } })).toBe(1);
    expect(await rawPrisma.userInvitation.count({ where: { customerId, email: request.email } })).toBe(1);
  });

  it("two operators pressing Approve make one customer", async () => {
    const request = await waitingRequest();
    const [a, b] = await Promise.all([approve(request.id, request.slug), approve(request.id, request.slug)]);
    expect([a, b].filter((r) => r.success)).toHaveLength(1);
    expect(await rawPrisma.customer.count({ where: { contactEmail: request.email } })).toBe(1);
  });

  it("a failed approval goes back to waiting", async () => {
    const request = await waitingRequest();
    const taken = await waitingRequest();
    await approve(taken.id, taken.slug);
    const f = new FormData();
    f.set("slug", "Not A Valid Slug!");
    expect((await ops.approveSignup(request.id, {}, f)).error).toBeDefined();
    expect((await rawPrisma.signupRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe("PENDING_APPROVAL");
  });

  it("rejecting queues the email and cannot be decided twice", async () => {
    const request = await waitingRequest();
    expect((await ops.rejectSignup(request.id, "Not a business")).success).toBeDefined();
    expect((await rawPrisma.signupRequest.findUniqueOrThrow({ where: { id: request.id } })).emailCiphertext).not.toBeNull();
    expect((await ops.rejectSignup(request.id, "again")).error).toBeDefined();
    expect((await approve(request.id, request.slug)).error).toBeDefined();
  });
});
