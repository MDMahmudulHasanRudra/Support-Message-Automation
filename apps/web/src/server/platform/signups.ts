import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { encryptSecret } from "@support-automation/db";
import { formatMoneyMinor, SIGNUP_FORM_MAX_AGE_MS, SIGNUP_MIN_FILL_MS } from "@support-automation/shared";
import { globalPrisma } from "@/server/db";
import { requirePlatformHost } from "@/server/hostScope";

/** Public sign-up (SIGNUP.md): the readings, and the small helpers both the public form and the operator's page use. */

export interface PublicPlan {
  id: string;
  name: string;
  description: string | null;
  price: string;
  interval: string;
  trialDays: number;
  maxWhatsAppAccounts: number | null;
  maxUsers: number | null;
  allModules: boolean;
  moduleCount: number;
}

export async function signupIsOpen(): Promise<boolean> {
  const settings = await globalPrisma.platformBillingSettings.findUnique({ where: { id: "default" }, select: { signupEnabled: true } });
  return settings?.signupEnabled === true;
}

/** Null when these pages must not exist on this address or sign-up is switched off. */
export async function loadPublicPlans(): Promise<PublicPlan[] | null> {
  await requirePlatformHost();
  if (!(await signupIsOpen())) return null;
  const rows = await globalPrisma.plan.findMany({ where: { isActive: true, isPublic: true }, orderBy: [{ sortOrder: "asc" }, { priceMinor: "asc" }] });
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    price: formatMoneyMinor(p.priceMinor, p.currency),
    interval: p.interval,
    trialDays: p.trialDays,
    maxWhatsAppAccounts: p.maxWhatsAppAccounts,
    maxUsers: p.maxUsers,
    allModules: p.allModules,
    moduleCount: p.features.length,
  }));
}

export async function signupAddressSuffix(): Promise<string | null> {
  const settings = await globalPrisma.platformDomainSettings.findUnique({ where: { id: "default" }, select: { hostRoutingEnabled: true, rootDomain: true } });
  return settings?.hostRoutingEnabled && settings.rootDomain ? settings.rootDomain : null;
}

const secret = () => process.env.NEXTAUTH_SECRET ?? "signup";
const sign = (value: string) => createHmac("sha256", secret()).update(`signup-form:${value}`).digest("base64url");

/** Proves when the form was shown, so a form posted at once, or a stale one replayed, can be told apart. */
export function issueSignupFormStamp(now = Date.now()): string {
  return `${now}.${sign(String(now))}`;
}

export function signupStampIsHuman(stamp: unknown, now = Date.now()): boolean {
  if (typeof stamp !== "string") return false;
  const [at, mac] = stamp.split(".");
  if (!at || !mac) return false;
  const expected = Buffer.from(sign(at));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  const age = now - Number(at);
  return age >= SIGNUP_MIN_FILL_MS && age <= SIGNUP_FORM_MAX_AGE_MS;
}

export const hashSignupToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newSignupToken = () => randomBytes(32).toString("base64url");
export const hashSignupAddress = (address: string) => createHash("sha256").update(`${secret()}:${address}`).digest("hex");

export type SignupMail = { kind: "VERIFY"; link: string; businessName: string } | { kind: "REJECTED"; reason: string | null; businessName: string };

/** Encrypted so the worker can send it. Wiped once sent, and the verification link is not stored any other way. */
export const sealSignupMail = (mail: SignupMail) => encryptSecret(JSON.stringify(mail));

/** The address links are built from: the platform's own, never whatever the request claimed to be. */
export async function platformBaseUrl(): Promise<string> {
  const settings = await globalPrisma.platformDomainSettings.findUnique({ where: { id: "default" }, select: { adminHostnames: true } });
  const host = settings?.adminHostnames?.[0];
  return (host ? `https://${host}` : (process.env.NEXTAUTH_URL ?? "")).replace(/\/+$/, "");
}

export async function listSignupRequests() {
  const rows = await globalPrisma.signupRequest.findMany({ orderBy: { createdAt: "desc" }, take: 300, include: { plan: { select: { id: true, name: true } } } });
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    businessName: r.businessName,
    ownerName: r.ownerName,
    email: r.email,
    phone: r.phone,
    slug: r.slug,
    planId: r.plan?.id ?? null,
    planName: r.plan?.name ?? null,
    verifiedAt: r.verifiedAt?.toISOString() ?? null,
    emailError: r.emailError,
    decidedBy: r.decidedBy,
    rejectReason: r.rejectReason,
    customerId: r.customerId,
    createdAt: r.createdAt.toISOString(),
  }));
}
export type SignupRow = Awaited<ReturnType<typeof listSignupRequests>>[number];

/** Whether the platform can send email at all: sign-up depends on it, so the switch refuses without it. */
export async function platformEmailReady(): Promise<boolean> {
  if (process.env.PLATFORM_SMTP_HOST?.trim() && process.env.PLATFORM_SMTP_FROM_ADDRESS?.trim()) return true;
  const row = await globalPrisma.platformEmailSettings.findUnique({ where: { id: "default" }, select: { enabled: true, host: true, fromAddress: true } });
  return Boolean(row?.enabled && row.host && row.fromAddress);
}
