"use server";

import { revalidatePath } from "next/cache";
import { validateProjectSlug } from "@support-automation/shared";
import { globalPrisma } from "@/server/db";
import { requireOperatorAction } from "@/server/platform/auth";
import { logPlatformEvent } from "@/server/platform/log";
import { platformEmailReady, sealSignupMail } from "@/server/platform/signups";
import { createCustomer } from "@/server/platform/actions/customers";

/** The operator's side of sign-up (SIGNUP.md). Approving goes through Add customer itself: there is no second way to make one. */

export interface SignupDecision {
  error?: string;
  success?: string;
  link?: string;
  notes?: string[];
}

const refresh = () => revalidatePath("/platform/signups");

export async function setSignupEnabled(on: boolean): Promise<SignupDecision> {
  const access = await requireOperatorAction();
  if ("denied" in access) return { error: access.denied };
  if (on) {
    const plans = await globalPrisma.plan.count({ where: { isActive: true, isPublic: true } });
    if (plans === 0) return { error: "Mark at least one plan as shown on the pricing page first (Plans & billing)." };
    if (!(await platformEmailReady())) return { error: "Set up platform email first (Settings): people confirm their address by email." };
  }
  await globalPrisma.platformBillingSettings.upsert({ where: { id: "default" }, create: { id: "default", signupEnabled: on }, update: { signupEnabled: on, updatedByUsername: access.operator.username } });
  await logPlatformEvent("WARN", on ? "Public sign-up switched on" : "Public sign-up switched off", { changedBy: access.operator.username });
  refresh();
  return { success: on ? "Sign-up is open." : "Sign-up is closed." };
}

export async function approveSignup(id: string, _prev: SignupDecision, form: FormData): Promise<SignupDecision> {
  const access = await requireOperatorAction();
  if ("denied" in access) return { error: access.denied };
  const slug = String(form.get("slug") ?? "").trim().toLowerCase();
  const slugError = validateProjectSlug(slug);
  if (slugError) return { error: slugError };
  const planId = String(form.get("planId") ?? "");

  // Claimed first, so two operators pressing Approve cannot make two customers.
  const now = new Date();
  const claimed = await globalPrisma.signupRequest.updateMany({ where: { id, status: "PENDING_APPROVAL" }, data: { status: "APPROVED", decidedAt: now, decidedBy: access.operator.username, slug } });
  if (claimed.count === 0) return { error: "Somebody has already decided this request." };
  const request = await globalPrisma.signupRequest.findUniqueOrThrow({ where: { id } });
  const release = () => globalPrisma.signupRequest.updateMany({ where: { id, status: "APPROVED", customerId: null }, data: { status: "PENDING_APPROVAL", decidedAt: null, decidedBy: null } });

  const domains = await globalPrisma.platformDomainSettings.findUnique({ where: { id: "default" }, select: { hostRoutingEnabled: true, rootDomain: true } });
  const fields: Record<string, string> = {
    name: request.businessName,
    contactName: request.ownerName,
    contactEmail: request.email,
    projectName: request.businessName,
    projectSlug: slug,
    ownerMode: "invite",
    ownerName: request.ownerName,
    ownerEmail: request.email,
    moduleSetup: "PLAN",
  };
  if (request.phone) fields.contactPhone = request.phone;
  if (planId) fields.planId = planId;
  if (domains?.hostRoutingEnabled && domains.rootDomain) fields.hostname = `${slug}.${domains.rootDomain}`;
  if (form.get("autoEnforce") === "on") fields.autoEnforce = "on";
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);

  const made = await createCustomer({}, f);
  if (!made.created) {
    await release();
    return { error: made.error ?? Object.values(made.fieldErrors ?? {})[0] ?? "The customer could not be created." };
  }
  await globalPrisma.signupRequest.update({ where: { id }, data: { customerId: made.created.customerId } });
  await logPlatformEvent("INFO", `Sign-up approved: ${request.businessName}`, { signupId: id, customerId: made.created.customerId, by: access.operator.username }, { type: "Customer", id: made.created.customerId });
  refresh();
  return { success: `${request.businessName} is set up.`, link: made.created.link, notes: made.created.notes };
}

export async function rejectSignup(id: string, reason: string): Promise<SignupDecision> {
  const access = await requireOperatorAction();
  if ("denied" in access) return { error: access.denied };
  const row = await globalPrisma.signupRequest.findUnique({ where: { id }, select: { businessName: true } });
  if (!row) return { error: "That request is no longer here." };
  const why = reason.trim().slice(0, 500) || null;
  const done = await globalPrisma.signupRequest.updateMany({
    where: { id, status: "PENDING_APPROVAL" },
    data: { status: "REJECTED", decidedAt: new Date(), decidedBy: access.operator.username, rejectReason: why, emailCiphertext: sealSignupMail({ kind: "REJECTED", reason: why, businessName: row.businessName }) },
  });
  if (done.count === 0) return { error: "Somebody has already decided this request." };
  await logPlatformEvent("INFO", `Sign-up rejected: ${row.businessName}`, { signupId: id, by: access.operator.username });
  refresh();
  return { success: "Rejected. They will be told by email." };
}
