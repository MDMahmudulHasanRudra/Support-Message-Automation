"use server";

import { headers } from "next/headers";
import { readSignupFields, SIGNUP_VERIFY_HOURS, validateCustomerHostname, type SignupFieldErrors } from "@support-automation/shared";
import { globalPrisma } from "@/server/db";
import { requirePlatformHost } from "@/server/hostScope";
import { clientAddress, FailureWindow } from "@/server/authRateLimit";
import { logPlatformEvent } from "@/server/platform/log";
import { hashSignupAddress, hashSignupToken, newSignupToken, platformBaseUrl, sealSignupMail, signupIsOpen, signupStampIsHuman } from "@/server/platform/signups";

/**
 * The public sign-up form (SIGNUP.md). No session: anyone on the internet can call these, so nothing here creates a
 * customer. It only records a request for a platform operator. The answer is the same whether the email is new, already
 * waiting or already a customer, so the form cannot be used to find out who uses the product.
 */

export interface SignupFormState {
  sent?: boolean;
  error?: string;
  fieldErrors?: SignupFieldErrors;
}

const perAddress = new FailureWindow({ maxFailures: 8, windowMs: 3_600_000, maxKeys: 20_000 });
const MAX_OPEN_REQUESTS = 500;
const RESEND_AFTER_MS = 2 * 60_000;

export async function submitSignup(_prev: SignupFormState, form: FormData): Promise<SignupFormState> {
  await requirePlatformHost();
  if (!(await signupIsOpen())) return { error: "Sign-up is closed right now." };
  const sent: SignupFormState = { sent: true };

  // A hidden field only a robot fills in, and a form posted faster than a person types: told it worked, nothing is kept.
  if (String(form.get("website") ?? "") !== "" || !signupStampIsHuman(form.get("stamp"))) return sent;

  const address = clientAddress(await headers());
  if (perAddress.check(address).limited) return { error: "Too many attempts from this connection. Please try again in an hour." };
  perAddress.recordFailure(address);

  const read = readSignupFields(Object.fromEntries(form.entries()));
  if ("errors" in read) return { fieldErrors: read.errors };
  const { fields } = read;

  const planId = String(form.get("planId") ?? "");
  const plan = planId ? await globalPrisma.plan.findFirst({ where: { id: planId, isActive: true, isPublic: true }, select: { id: true } }) : null;
  if (!plan) return { fieldErrors: { planId: "Choose a plan." } };

  const domains = await globalPrisma.platformDomainSettings.findUnique({ where: { id: "default" } });
  if (domains?.hostRoutingEnabled && domains.rootDomain) {
    const hostname = validateCustomerHostname(`${fields.slug}.${domains.rootDomain}`, { hostRoutingEnabled: true, rootDomain: domains.rootDomain, adminHostnames: domains.adminHostnames, reservedLabels: domains.reservedLabels });
    if ("error" in hostname) return { fieldErrors: { slug: "That address is not available. Try another." } };
    if (await globalPrisma.customerDomain.findUnique({ where: { hostname: hostname.hostname }, select: { id: true } })) return { fieldErrors: { slug: "That address is already taken. Try another." } };
  }

  if ((await globalPrisma.signupRequest.count({ where: { status: { in: ["EMAIL_PENDING", "PENDING_APPROVAL"] } } })) >= MAX_OPEN_REQUESTS) {
    return { error: "We have a lot of requests right now. Please try again tomorrow." };
  }

  const token = newSignupToken();
  const base = await platformBaseUrl();
  const now = new Date();
  const data = {
    ...fields,
    planId: plan.id,
    verifyTokenHash: hashSignupToken(token),
    verifyExpiresAt: new Date(now.getTime() + SIGNUP_VERIFY_HOURS * 3_600_000),
    emailCiphertext: sealSignupMail({ kind: "VERIFY", link: `${base}/signup/verify/${token}`, businessName: fields.businessName }),
    emailError: null,
    addressHash: hashSignupAddress(address),
  };

  const open = await globalPrisma.signupRequest.findFirst({ where: { email: fields.email, status: { in: ["EMAIL_PENDING", "PENDING_APPROVAL"] } }, select: { id: true, status: true, updatedAt: true } });
  if (open) {
    // Pressed again: a fresh link if the first has had time to arrive. One already waiting for approval is left alone.
    if (open.status === "EMAIL_PENDING" && now.getTime() - open.updatedAt.getTime() > RESEND_AFTER_MS) {
      await globalPrisma.signupRequest.updateMany({ where: { id: open.id, status: "EMAIL_PENDING" }, data });
    }
    return sent;
  }
  try {
    await globalPrisma.signupRequest.create({ data });
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err;
  }
  return sent;
}

export type VerifyResult = "VERIFIED" | "ALREADY" | "INVALID";

/** Pressed, not opened: mail scanners open links, and only a person presses the button. */
export async function verifySignup(token: string): Promise<VerifyResult> {
  await requirePlatformHost();
  if (typeof token !== "string" || token.length > 100) return "INVALID";
  const now = new Date();
  const verifyTokenHash = hashSignupToken(token);
  const done = await globalPrisma.signupRequest.updateMany({
    where: { verifyTokenHash, status: "EMAIL_PENDING", verifyExpiresAt: { gt: now } },
    data: { status: "PENDING_APPROVAL", verifiedAt: now, emailCiphertext: null },
  });
  if (done.count === 1) {
    const row = await globalPrisma.signupRequest.findUniqueOrThrow({ where: { verifyTokenHash }, select: { id: true, businessName: true } });
    await logPlatformEvent("INFO", `Sign-up waiting for approval: ${row.businessName}`, { signupId: row.id });
    return "VERIFIED";
  }
  const row = await globalPrisma.signupRequest.findUnique({ where: { verifyTokenHash }, select: { status: true } });
  return row && row.status !== "EMAIL_PENDING" && row.status !== "EXPIRED" ? "ALREADY" : "INVALID";
}
