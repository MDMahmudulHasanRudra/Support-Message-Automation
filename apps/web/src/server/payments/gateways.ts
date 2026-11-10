import { gatewayAmount, readGatewayAmount, type BkashCredentials, type PaymentModeValue, type SslCommerzCredentials } from "@support-automation/shared";

/**
 * The two payment gateways (PAYMENT_LINKS.md). Only this file speaks to them, only to the fixed addresses below, and every
 * call takes its `fetch` so tests never reach the internet. Written from the providers' published APIs and tested against
 * simulated answers: neither has been exercised against a real merchant account yet.
 *
 * A gateway's redirect or callback is never believed. Each outcome comes from asking the gateway directly, server to server.
 */

type Fetch = typeof fetch;
const TIMEOUT_MS = 20_000;

export type StartResult = { ok: true; url: string; sessionRef: string } | { ok: false; message: string };

/** What a gateway says about a payment, after asking it directly. UNKNOWN means it could not say: never read as failed or paid. */
export type GatewayVerdict =
  | { state: "PAID"; amountMinor: bigint | null; currency: string | null; txnId: string | null }
  | { state: "NOT_PAID"; note: string }
  | { state: "UNKNOWN"; note: string };

const SSL_BASE: Record<PaymentModeValue, string> = { SANDBOX: "https://sandbox.sslcommerz.com", LIVE: "https://securepay.sslcommerz.com" };
const BKASH_BASE: Record<PaymentModeValue, string> = { SANDBOX: "https://tokenized.sandbox.bka.sh/v1.2.0-beta", LIVE: "https://tokenized.pay.bka.sh/v1.2.0-beta" };

async function call(fetchImpl: Fetch, url: string, init: RequestInit): Promise<{ ok: true; status: number; body: Record<string, unknown> } | { ok: false; note: string }> {
  try {
    const res = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    try {
      return { ok: true, status: res.status, body: JSON.parse(text) as Record<string, unknown> };
    } catch {
      return { ok: false, note: `The gateway's answer could not be read (HTTP ${res.status}).` };
    }
  } catch (err) {
    return { ok: false, note: `The gateway did not answer: ${(err as Error).name}.` };
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);

// ── SSLCOMMERZ ──────────────────────────────────────────────────────────────────────────────────

export async function startSslCommerz(
  input: { creds: SslCommerzCredentials; mode: PaymentModeValue; reference: string; amountMinor: bigint; description: string; customerName: string | null; callbackBase: string },
  fetchImpl: Fetch = fetch,
): Promise<StartResult> {
  const form = new URLSearchParams({
    store_id: input.creds.storeId,
    store_passwd: input.creds.storePassword,
    total_amount: gatewayAmount(input.amountMinor),
    currency: "BDT",
    tran_id: input.reference,
    success_url: `${input.callbackBase}?r=success`,
    fail_url: `${input.callbackBase}?r=fail`,
    cancel_url: `${input.callbackBase}?r=cancel`,
    ipn_url: `${input.callbackBase}?r=ipn`,
    cus_name: input.customerName || "Customer",
    cus_email: "customer@example.com",
    cus_phone: "01700000000",
    cus_add1: "Bangladesh",
    cus_city: "Dhaka",
    cus_country: "Bangladesh",
    shipping_method: "NO",
    product_name: input.description.slice(0, 100) || "Payment",
    product_category: "General",
    product_profile: "general",
  });
  const r = await call(fetchImpl, `${SSL_BASE[input.mode]}/gwprocess/v4/api.php`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
  if (!r.ok) return { ok: false, message: r.note };
  const url = str(r.body.GatewayPageURL);
  if (r.body.status !== "SUCCESS" || !url || !url.startsWith("https://")) return { ok: false, message: str(r.body.failedreason) ?? "SSLCOMMERZ refused this payment." };
  return { ok: true, url, sessionRef: str(r.body.sessionkey) ?? input.reference };
}

function readSslAnswer(body: Record<string, unknown>): GatewayVerdict {
  const status = str(body.status);
  if (status === "VALID" || status === "VALIDATED") {
    return { state: "PAID", amountMinor: readGatewayAmount(body.amount ?? body.currency_amount), currency: str(body.currency_type) ?? str(body.currency), txnId: str(body.bank_tran_id) ?? str(body.val_id) };
  }
  if (status === "FAILED" || status === "CANCELLED" || status === "UNATTEMPTED" || status === "EXPIRED" || status === "INVALID_TRANSACTION") return { state: "NOT_PAID", note: `SSLCOMMERZ says ${status}.` };
  return { state: "UNKNOWN", note: `SSLCOMMERZ answered ${status ?? "nothing"}.` };
}

/** Asks SSLCOMMERZ about one validation id, the one thing a callback carries that matters. */
export async function validateSslCommerz(input: { creds: SslCommerzCredentials; mode: PaymentModeValue; valId: string }, fetchImpl: Fetch = fetch): Promise<GatewayVerdict & { reference?: string | null }> {
  const q = new URLSearchParams({ val_id: input.valId, store_id: input.creds.storeId, store_passwd: input.creds.storePassword, format: "json", v: "1" });
  const r = await call(fetchImpl, `${SSL_BASE[input.mode]}/validator/api/validationserverAPI.php?${q}`, { method: "GET" });
  if (!r.ok) return { state: "UNKNOWN", note: r.note };
  return { ...readSslAnswer(r.body), reference: str(r.body.tran_id) };
}

/** Asks SSLCOMMERZ about our own reference, for "check again". */
export async function querySslCommerz(input: { creds: SslCommerzCredentials; mode: PaymentModeValue; reference: string }, fetchImpl: Fetch = fetch): Promise<GatewayVerdict> {
  const q = new URLSearchParams({ tran_id: input.reference, store_id: input.creds.storeId, store_passwd: input.creds.storePassword, format: "json", v: "1" });
  const r = await call(fetchImpl, `${SSL_BASE[input.mode]}/validator/api/merchantTransIDvalidationAPI.php?${q}`, { method: "GET" });
  if (!r.ok) return { state: "UNKNOWN", note: r.note };
  const element = Array.isArray(r.body.element) ? (r.body.element as Array<Record<string, unknown>>) : [];
  const paid = element.find((e) => e.status === "VALID" || e.status === "VALIDATED");
  if (paid) return readSslAnswer(paid);
  if (element.length) return readSslAnswer(element[0]!);
  return Number(r.body.no_of_trans_found) === 0 ? { state: "NOT_PAID", note: "SSLCOMMERZ has no such payment." } : { state: "UNKNOWN", note: "SSLCOMMERZ gave no answer." };
}

// ── bKash ───────────────────────────────────────────────────────────────────────────────────────

async function bkashToken(creds: BkashCredentials, mode: PaymentModeValue, fetchImpl: Fetch): Promise<{ token: string } | { note: string }> {
  const r = await call(fetchImpl, `${BKASH_BASE[mode]}/tokenized/checkout/token/grant`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", username: creds.username, password: creds.password },
    body: JSON.stringify({ app_key: creds.appKey, app_secret: creds.appSecret }),
  });
  if (!r.ok) return { note: r.note };
  const token = str(r.body.id_token);
  return token ? { token } : { note: str(r.body.statusMessage) ?? "bKash refused these account details." };
}

const bkashHeaders = (creds: BkashCredentials, token: string) => ({ "Content-Type": "application/json", Accept: "application/json", Authorization: token, "X-APP-Key": creds.appKey });

export async function startBkash(input: { creds: BkashCredentials; mode: PaymentModeValue; reference: string; amountMinor: bigint; callbackUrl: string }, fetchImpl: Fetch = fetch): Promise<StartResult> {
  const grant = await bkashToken(input.creds, input.mode, fetchImpl);
  if ("note" in grant) return { ok: false, message: grant.note };
  const r = await call(fetchImpl, `${BKASH_BASE[input.mode]}/tokenized/checkout/create`, {
    method: "POST",
    headers: bkashHeaders(input.creds, grant.token),
    body: JSON.stringify({ mode: "0011", payerReference: input.reference.slice(0, 20), callbackURL: input.callbackUrl, amount: gatewayAmount(input.amountMinor), currency: "BDT", intent: "sale", merchantInvoiceNumber: input.reference }),
  });
  if (!r.ok) return { ok: false, message: r.note };
  const url = str(r.body.bkashURL);
  const paymentId = str(r.body.paymentID);
  if (!url || !paymentId || !url.startsWith("https://")) return { ok: false, message: str(r.body.statusMessage) ?? "bKash refused this payment." };
  return { ok: true, url, sessionRef: paymentId };
}

function readBkashAnswer(body: Record<string, unknown>): GatewayVerdict {
  const status = str(body.transactionStatus);
  if (status === "Completed") return { state: "PAID", amountMinor: readGatewayAmount(body.amount), currency: str(body.currency), txnId: str(body.trxID) };
  if (status === "Initiated" || status === "Pending Authorized" || status === "Authorized") return { state: "UNKNOWN", note: `bKash says ${status}.` };
  if (status) return { state: "NOT_PAID", note: `bKash says ${status}.` };
  return { state: "NOT_PAID", note: str(body.statusMessage) ?? "bKash did not complete this payment." };
}

/** Takes the money. Called once per try: if the answer is lost, the outcome is unknown and `queryBkash` finds it. */
export async function executeBkash(input: { creds: BkashCredentials; mode: PaymentModeValue; paymentId: string }, fetchImpl: Fetch = fetch): Promise<GatewayVerdict> {
  const grant = await bkashToken(input.creds, input.mode, fetchImpl);
  if ("note" in grant) return { state: "UNKNOWN", note: grant.note };
  const r = await call(fetchImpl, `${BKASH_BASE[input.mode]}/tokenized/checkout/execute`, { method: "POST", headers: bkashHeaders(input.creds, grant.token), body: JSON.stringify({ paymentID: input.paymentId }) });
  if (!r.ok) return { state: "UNKNOWN", note: r.note };
  return readBkashAnswer(r.body);
}

export async function queryBkash(input: { creds: BkashCredentials; mode: PaymentModeValue; paymentId: string }, fetchImpl: Fetch = fetch): Promise<GatewayVerdict> {
  const grant = await bkashToken(input.creds, input.mode, fetchImpl);
  if ("note" in grant) return { state: "UNKNOWN", note: grant.note };
  const r = await call(fetchImpl, `${BKASH_BASE[input.mode]}/tokenized/checkout/payment/status`, { method: "POST", headers: bkashHeaders(input.creds, grant.token), body: JSON.stringify({ paymentID: input.paymentId }) });
  if (!r.ok) return { state: "UNKNOWN", note: r.note };
  return readBkashAnswer(r.body);
}
