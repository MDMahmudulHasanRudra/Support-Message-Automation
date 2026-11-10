/**
 * Payment links (PAYMENT_LINKS.md, feature PAYMENT_LINKS): a link a business sends in a chat so a customer can pay on
 * SSLCOMMERZ or bKash, into the business's own merchant account. Money is BigInt minor units (paisa) everywhere; a gateway
 * speaks decimal text, and these functions are the only crossing.
 */

export const PAYMENT_PROVIDERS = ["SSLCOMMERZ", "BKASH"] as const;
export type PaymentProviderValue = (typeof PAYMENT_PROVIDERS)[number];
export const PAYMENT_PROVIDER_LABEL: Record<PaymentProviderValue, string> = { SSLCOMMERZ: "SSLCOMMERZ", BKASH: "bKash" };

export function isPaymentProvider(value: unknown): value is PaymentProviderValue {
  return typeof value === "string" && (PAYMENT_PROVIDERS as readonly string[]).includes(value);
}

export const PAYMENT_LINK_CURRENCY = "BDT";
export const MAX_PAYMENT_MINOR = BigInt(50_000_000); // BDT 500,000: above this, a link is more likely a typing slip.
export const PAYMENT_LINK_DEFAULT_DAYS = 7;

/** "1,500" or "1500.50" into paisa. Null for anything that is not a positive amount with at most two decimals. */
export function parseLinkAmount(text: string): bigint | null {
  const clean = text.trim().replace(/,/g, "");
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(clean);
  if (!match) return null;
  const minor = BigInt(match[1]!) * BigInt(100) + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  return minor > BigInt(0) ? minor : null;
}

/** Paisa as a gateway expects it: "1500.00". */
export function gatewayAmount(minor: bigint): string {
  const hundred = BigInt(100);
  return `${minor / hundred}.${String(minor % hundred).padStart(2, "0")}`;
}

/** A gateway's amount back into paisa, exactly. Null when it cannot be read: never rounded. */
export function readGatewayAmount(value: unknown): bigint | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const match = /^(\d{1,12})(?:\.(\d{1,4}))?$/.exec(text);
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(4, "0");
  if (fraction.slice(2) !== "00") return null;
  return BigInt(match[1]!) * BigInt(100) + BigInt(fraction.slice(0, 2));
}

export function formatPaymentAmount(minor: bigint): string {
  const hundred = BigInt(100);
  const whole = (minor / hundred).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rest = minor % hundred;
  return `BDT ${whole}${rest > BigInt(0) ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

export const formatPaymentLinkNumber = (n: number) => `PAY-${String(n).padStart(4, "0")}`;

/** The line that goes in the reply box. A person presses send. */
export function paymentLinkMessage(amount: string, description: string | null, url: string): string {
  return `${description ? `${description}\n` : ""}Please pay ${amount} here:\n${url}`;
}

export interface SslCommerzCredentials {
  storeId: string;
  storePassword: string;
}

export interface BkashCredentials {
  appKey: string;
  appSecret: string;
  username: string;
  password: string;
}

export const PAYMENT_MODES = ["SANDBOX", "LIVE"] as const;
export type PaymentModeValue = (typeof PAYMENT_MODES)[number];

export function gatewayCredentialFields(provider: PaymentProviderValue): Array<{ key: string; label: string }> {
  return provider === "SSLCOMMERZ"
    ? [{ key: "storeId", label: "Store ID" }, { key: "storePassword", label: "Store password" }]
    : [{ key: "appKey", label: "App key" }, { key: "appSecret", label: "App secret" }, { key: "username", label: "Username" }, { key: "password", label: "Password" }];
}
