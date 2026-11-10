import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createProjectWithDefaults, encryptSecret, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Payment links (PAYMENT_LINKS.md), against simulated gateways. A payment counts only when the gateway confirms it directly,
 * for exactly the amount asked; it settles the invoice once however many times it is reported, and anything odd is left
 * for a person instead of being guessed.
 */

process.env.AI_CREDENTIALS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
process.env.NEXTAUTH_URL ??= "https://app.example.test";

let current: Session | null;
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => {
    if (!current) throw new Error("NEXT_REDIRECT /login");
    return current;
  },
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  headers: async () => new Headers({ "x-relqivo-host": "localhost" }),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => p, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const actions = await import("@/server/actions/paymentLinks");
const core = await import("@/server/payments/core");
const { beginPayment } = await import("@/server/actions/paymentPublic");
const { hashPaymentToken } = await import("@/server/platform/paymentLookup");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const ssl = await import("@/app/api/pay/sslcommerz/[token]/route");
const bkash = await import("@/app/api/pay/bkash/[token]/route");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const fx = {} as { a: { id: string; slug: string; name: string; status: "ACTIVE" }; b: { id: string; slug: string; name: string; status: "ACTIVE" }; clientId: string; full: Session; viewer: Session; roles: string[]; users: string[] };
const inA = <T,>(fn: () => Promise<T>) => runWithProject(fx.a as never, fn);
let n = 0;

type Answer = { match: string; body: unknown };
let answers: Answer[] = [];
const calls: string[] = [];
function gatewayAnswers(list: Answer[]) {
  answers = list;
  calls.length = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(String(url));
    const hit = answers.find((a) => String(url).includes(a.match));
    if (!hit) throw new Error(`Unexpected call to ${url}`);
    return new Response(JSON.stringify(hit.body), { status: 200 });
  });
}

async function role(name: string, keys: string[]) {
  const permissions = await Promise.all(keys.map((key) => { const def = PERMISSIONS.find((p) => p.key === key)!; return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } }); }));
  const r = await rawPrisma.permissionModule.create({ data: { name: `${name} ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  fx.roles.push(r.id);
  return r.id;
}
async function user(name: string, roleId: string) {
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  await rawPrisma.projectAccess.create({ data: { projectId: fx.a.id, userId: u.id } });
  fx.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name, tenant: null } as unknown as Session;
}
async function due(amount = "1500.00") {
  n += 1;
  return rawPrisma.clientDue.create({ data: { projectId: fx.a.id, clientId: fx.clientId, dueDate: new Date("2026-11-01"), amount, currency: "BDT", invoiceNumber: `INV-${tag}-${n}` } });
}
async function link(amount = "1500", clientDueId?: string) {
  current = fx.full;
  const r = await inA(() => actions.createPaymentLink({ amount, clientDueId }));
  if ("error" in r) throw new Error(r.error);
  const token = r.url.split("/pay/")[1]!;
  return { id: r.id, token };
}
const attempt = (linkId: string, provider: "SSLCOMMERZ" | "BKASH", sessionRef: string) => rawPrisma.paymentAttempt.create({ data: { projectId: fx.a.id, linkId, provider, mode: "SANDBOX", reference: `R-${randomUUID()}`, sessionRef } });
const paid = (amountMinor: bigint | null = BigInt(150000)) => ({ state: "PAID" as const, amountMinor, currency: "BDT", txnId: `T${++n}` });
const row = (id: string) => rawPrisma.paymentLink.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  Object.assign(fx, { roles: [], users: [] });
  const make = async (s: string) => {
    const p = await createProjectWithDefaults({ name: `${s} ${tag}`, slug: `${s}-${tag}`, status: "ACTIVE", creatorUserId: null }, rawPrisma);
    for (const key of ["PAYMENT_LINKS", "CLIENT_CENTER"]) await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key } }, create: { projectId: p.id, key, enabled: true }, update: { enabled: true } });
    return { id: p.id, slug: p.slug, name: s, status: "ACTIVE" as const };
  };
  fx.a = await make("pa");
  fx.b = await make("pb");
  forgetProjectFeatureStates();
  fx.clientId = (await rawPrisma.client.create({ data: { projectId: fx.a.id, code: `C-${tag}`, name: "Payer" } })).id;
  fx.full = await user("p_full", await role("P all", ["payments.view", "payments.create", "payments.manage", "clients.view_billing", "clients.view"]));
  fx.viewer = await user("p_view", await role("P read", ["payments.view"]));
  await rawPrisma.paymentGateway.create({ data: { projectId: fx.a.id, provider: "SSLCOMMERZ", enabled: true, credentialsCiphertext: encryptSecret(JSON.stringify({ storeId: "s", storePassword: "p" })) } });
  await rawPrisma.paymentGateway.create({ data: { projectId: fx.a.id, provider: "BKASH", enabled: true, credentialsCiphertext: encryptSecret(JSON.stringify({ appKey: "k", appSecret: "x", username: "u", password: "p" })) } });
});

beforeEach(() => {
  current = fx.full;
  vi.unstubAllGlobals();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  const tables = (await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`).map((t) => t.table_name);
  for (const id of [fx.a.id, fx.b.id]) {
    for (let pass = 0; pass < 5; pass++) for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, id).catch(() => undefined);
    await rawPrisma.project.deleteMany({ where: { id } });
  }
  await rawPrisma.user.deleteMany({ where: { id: { in: fx.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: fx.roles } } });
});

describe("settling", () => {
  it("a confirmed payment closes the link and settles the invoice, once", async () => {
    const d = await due();
    const l = await link("1500", d.id);
    const a = await attempt(l.id, "SSLCOMMERZ", "s1");
    const verdict = paid();
    expect(await inA(() => core.settleAttempt(a.id, verdict))).toBe("PAID");
    expect(await inA(() => core.settleAttempt(a.id, verdict))).toBe("ALREADY");
    expect(await row(l.id)).toMatchObject({ status: "PAID", paidProvider: "SSLCOMMERZ", needsAttention: false });
    expect((await row(l.id)).receiptNumber).toBeTruthy();
    expect(await rawPrisma.clientDue.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: "PAID" });
    expect(await rawPrisma.clientPayment.count({ where: { projectId: fx.a.id, idempotencyKey: { startsWith: `paylink-${l.id}` } } })).toBe(1);
  });

  it("the same report arriving together pays once", async () => {
    const d = await due();
    const l = await link("1500", d.id);
    const a = await attempt(l.id, "BKASH", "s2");
    const verdict = paid();
    const results = await Promise.allSettled([inA(() => core.settleAttempt(a.id, verdict)), inA(() => core.settleAttempt(a.id, verdict))]);
    expect(results.some((r) => r.status === "fulfilled" && r.value === "PAID")).toBe(true);
    expect(await rawPrisma.clientPayment.count({ where: { projectId: fx.a.id, idempotencyKey: { startsWith: `paylink-${l.id}` } } })).toBe(1);
  });

  it("a different amount is not a payment", async () => {
    const l = await link();
    const a = await attempt(l.id, "SSLCOMMERZ", "s3");
    expect(await inA(() => core.settleAttempt(a.id, paid(BigInt(100))))).toBe("MISMATCH");
    expect(await row(l.id)).toMatchObject({ status: "OPEN", needsAttention: true });
  });

  it("an amount that cannot be read is not a payment", async () => {
    const l = await link();
    const a = await attempt(l.id, "SSLCOMMERZ", "s4");
    expect(await inA(() => core.settleAttempt(a.id, paid(null)))).toBe("MISMATCH");
    expect((await row(l.id)).status).toBe("OPEN");
  });

  it("paid twice through two tries is flagged, and the invoice is settled once", async () => {
    const d = await due();
    const l = await link("1500", d.id);
    const [one, two] = [await attempt(l.id, "SSLCOMMERZ", "s5"), await attempt(l.id, "BKASH", "s6")];
    await inA(() => core.settleAttempt(one.id, paid()));
    expect(await inA(() => core.settleAttempt(two.id, paid()))).toBe("DOUBLE");
    expect(await row(l.id)).toMatchObject({ status: "PAID", needsAttention: true });
    expect(await rawPrisma.clientPayment.count({ where: { projectId: fx.a.id, idempotencyKey: { startsWith: `paylink-${l.id}` } } })).toBe(1);
  });

  it("no answer from the gateway is neither paid nor failed", async () => {
    const l = await link();
    const a = await attempt(l.id, "BKASH", "s7");
    expect(await inA(() => core.settleAttempt(a.id, { state: "UNKNOWN", note: "timeout" }))).toBe("UNKNOWN");
    expect(await row(l.id)).toMatchObject({ status: "OPEN", needsAttention: true });
    expect(await inA(() => core.settleAttempt(a.id, paid()))).toBe("PAID");
  });

  it("paid but the invoice cannot take it: the money is recorded and a person is told", async () => {
    const d = await due("1500.00");
    const l = await link("1500", d.id);
    await rawPrisma.clientDue.update({ where: { id: d.id }, data: { status: "PAID", paidAmount: "1500.00" } });
    const a = await attempt(l.id, "SSLCOMMERZ", "s8");
    expect(await inA(() => core.settleAttempt(a.id, paid()))).toBe("PAID");
    const saved = await row(l.id);
    expect(saved).toMatchObject({ status: "PAID", needsAttention: true });
    expect(saved.attentionNote).toContain("Record it by hand");
  });
});

describe("what a callback is allowed to do", () => {
  const sslPost = (token: string, fields: Record<string, string>, r = "success") => {
    const body = new URLSearchParams(fields);
    return ssl.POST(new NextRequest(`https://app.example.test/api/pay/sslcommerz/${token}?r=${r}`, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } }), { params: Promise.resolve({ token }) });
  };

  it("a forged success with no real validation changes nothing", async () => {
    const l = await link();
    const a = await attempt(l.id, "SSLCOMMERZ", "c1");
    gatewayAnswers([{ match: "validationserverAPI", body: { status: "INVALID_TRANSACTION" } }]);
    await sslPost(l.token, { tran_id: a.reference, val_id: "fake", status: "VALID", amount: "1500.00" });
    expect((await row(l.id)).status).toBe("OPEN");
  });

  it("a real validation for some other payment proves nothing", async () => {
    const l = await link();
    const a = await attempt(l.id, "SSLCOMMERZ", "c2");
    gatewayAnswers([{ match: "validationserverAPI", body: { status: "VALID", tran_id: "SOMETHING-ELSE", amount: "1500.00", currency_type: "BDT", bank_tran_id: "B1" } }]);
    await sslPost(l.token, { tran_id: a.reference, val_id: "v" });
    expect((await row(l.id)).status).toBe("OPEN");
  });

  it("the gateway's own confirmation pays it, and the amount comes from the gateway", async () => {
    const l = await link();
    const a = await attempt(l.id, "SSLCOMMERZ", "c3");
    gatewayAnswers([{ match: "validationserverAPI", body: { status: "VALID", tran_id: a.reference, amount: "1500.00", currency_type: "BDT", bank_tran_id: "B2" } }]);
    await sslPost(l.token, { tran_id: a.reference, val_id: "v", amount: "1.00" }, "ipn");
    expect(await row(l.id)).toMatchObject({ status: "PAID", gatewayTxnId: "B2" });
  });

  it("bKash: a failure callback takes no money, and a success is executed once", async () => {
    const l = await link();
    const a = await attempt(l.id, "BKASH", "PID1");
    const get = (status: string) => bkash.GET(new NextRequest(`https://app.example.test/api/pay/bkash/${l.token}?paymentID=PID1&status=${status}`), { params: Promise.resolve({ token: l.token }) });
    gatewayAnswers([]);
    await get("failure");
    expect(calls).toHaveLength(0);
    gatewayAnswers([
      { match: "token/grant", body: { id_token: "t" } },
      { match: "checkout/execute", body: { transactionStatus: "Completed", amount: "1500.00", currency: "BDT", trxID: "BK1" } },
      { match: "payment/status", body: { transactionStatus: "Completed", amount: "1500.00", currency: "BDT", trxID: "BK1" } },
    ]);
    await get("success");
    await get("success");
    expect(calls.filter((c) => c.includes("checkout/execute"))).toHaveLength(1);
    expect(await row(l.id)).toMatchObject({ status: "PAID", gatewayTxnId: "BK1" });
    void a;
  });

  it("a bKash payment id from another link is ignored", async () => {
    const [one, two] = [await link(), await link()];
    await attempt(one.id, "BKASH", "PID2");
    gatewayAnswers([]);
    await bkash.GET(new NextRequest(`https://app.example.test/api/pay/bkash/${two.token}?paymentID=PID2&status=success`), { params: Promise.resolve({ token: two.token }) });
    expect(calls).toHaveLength(0);
  });
});

describe("the link", () => {
  it("only the hash of the token is searchable, and the wrong token finds nothing", async () => {
    const l = await link();
    const saved = await row(l.id);
    expect(saved.tokenHash).toBe(hashPaymentToken(l.token));
    expect(saved.tokenCiphertext).not.toContain(l.token);
    expect(await beginPayment("wrong-token", "SSLCOMMERZ")).toEqual({ error: expect.any(String) });
  });

  it("a cancelled or expired link will not start a payment", async () => {
    const l = await link();
    await inA(() => actions.cancelPaymentLink(l.id));
    expect(await beginPayment(l.token, "SSLCOMMERZ")).toEqual({ error: expect.stringContaining("no longer") });
    const old = await link();
    await rawPrisma.paymentLink.update({ where: { id: old.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await beginPayment(old.token, "BKASH")).toEqual({ error: expect.stringContaining("expired") });
    expect(await row(old.id)).toMatchObject({ status: "EXPIRED" });
  });

  it("starting goes to the gateway's own page, and a project with the module off is closed", async () => {
    const l = await link();
    gatewayAnswers([{ match: "gwprocess", body: { status: "SUCCESS", GatewayPageURL: "https://sandbox.sslcommerz.com/pay/x", sessionkey: "S" } }]);
    expect(await beginPayment(l.token, "SSLCOMMERZ")).toEqual({ url: "https://sandbox.sslcommerz.com/pay/x" });
    await rawPrisma.projectFeature.update({ where: { projectId_key: { projectId: fx.a.id, key: "PAYMENT_LINKS" } }, data: { enabled: false } });
    forgetProjectFeatureStates();
    expect(await beginPayment(l.token, "SSLCOMMERZ")).toEqual({ error: expect.stringContaining("no longer") });
    await rawPrisma.projectFeature.update({ where: { projectId_key: { projectId: fx.a.id, key: "PAYMENT_LINKS" } }, data: { enabled: true } });
    forgetProjectFeatureStates();
  });

  it("a suspended business takes no payments", async () => {
    const l = await link();
    await rawPrisma.project.update({ where: { id: fx.a.id }, data: { status: "SUSPENDED" } });
    expect(await beginPayment(l.token, "SSLCOMMERZ")).toEqual({ error: expect.stringContaining("no longer") });
    await rawPrisma.project.update({ where: { id: fx.a.id }, data: { status: "ACTIVE" } });
  });

  it("an amount above what is left on the invoice is refused", async () => {
    const d = await due("1000.00");
    const r = await inA(() => actions.createPaymentLink({ amount: "1500", clientDueId: d.id }));
    expect(r).toEqual({ error: expect.stringContaining("more than is left") });
  });

  it("another project's invoice is simply not found", async () => {
    current = fx.full;
    const d = await due();
    const r = await runWithProject(fx.b as never, () => core.loadPaymentLink(d.id));
    expect(r).toBeNull();
  });
});

describe("permissions and account details", () => {
  it("reading does not let you create links or change accounts", async () => {
    current = fx.viewer;
    expect(await inA(() => actions.createPaymentLink({ amount: "100" }))).toEqual({ error: expect.any(String) });
    const f = new FormData();
    f.set("provider", "BKASH");
    expect((await inA(() => actions.saveGateway({}, f))).error).toBeDefined();
  });

  it("account details are stored encrypted and empty boxes keep them", async () => {
    current = fx.full;
    const f = new FormData();
    f.set("provider", "SSLCOMMERZ");
    f.set("storeId", "real-store");
    f.set("storePassword", "real-secret");
    f.set("enabled", "on");
    await inA(() => actions.saveGateway({}, f));
    const saved = await rawPrisma.paymentGateway.findFirstOrThrow({ where: { projectId: fx.a.id, provider: "SSLCOMMERZ" } });
    expect(saved.credentialsCiphertext).not.toContain("real-secret");
    const g = new FormData();
    g.set("provider", "SSLCOMMERZ");
    await inA(() => actions.saveGateway({}, g));
    expect((await rawPrisma.paymentGateway.findFirstOrThrow({ where: { projectId: fx.a.id, provider: "SSLCOMMERZ" } })).credentialsCiphertext).toBe(saved.credentialsCiphertext);
  });
});
