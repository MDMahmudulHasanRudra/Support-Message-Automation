"use server";

import { revalidatePath } from "next/cache";
import {
  isLeadSource,
  isLeadStage,
  LEAD_STAGE_LABELS,
  normalizeCurrencyCode,
  toMinor,
  validateLeadStageMove,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { emitWebhookEvent } from "@/server/integrationHub/webhooks";

/**
 * Sales pipeline actions (COMMERCE.md §Sales). `sales.manage` gates every write. A stage move is
 * conditional on the stage the person saw, and each change lands in the lead's append-only trail.
 */

export interface SalesResult {
  error?: string;
  success?: string;
  id?: string;
}

const text = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max) || null;

/** A `datetime-local` value is Dhaka wall-clock time; a value carrying its own zone is taken as is. */
function parseFollowUp(raw: string): Date | null {
  const v = raw.trim();
  if (!v) return null;
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.length === 16 ? `${v}:00` : v}+06:00`);
}

async function revalidate(...paths: string[]) {
  for (const p of paths) revalidatePath(await projectPath(p));
}

export interface LeadInput {
  name: string;
  phone: string;
  email: string;
  company: string;
  source: string;
  currency: string;
  value: string;
  nextFollowUpAt: string;
  notes: string;
  clientId: string;
}

export async function saveLead(id: string | null, input: LeadInput): Promise<SalesResult> {
  const access = await checkPermission("sales.manage");
  if ("denied" in access) return { error: access.denied };
  const name = text(input.name, 160);
  if (!name) return { error: "Enter the lead's name." };
  const valueRaw = String(input.value ?? "").trim();
  const value = valueRaw ? toMinor(valueRaw) : null;
  if (valueRaw && value === null) return { error: "The value must be a number with at most two decimals." };
  const currency = valueRaw ? normalizeCurrencyCode(String(input.currency ?? "")) : null;
  if (valueRaw && !currency) return { error: "Choose the value's currency, as a three-letter code such as BDT." };
  const followUp = parseFollowUp(String(input.nextFollowUpAt ?? ""));
  if (followUp && Number.isNaN(followUp.getTime())) return { error: "The follow-up date is not a valid date." };
  let clientId = text(input.clientId, 40);
  if (clientId && !(await prisma.client.findFirst({ where: { id: clientId }, select: { id: true } }).catch(() => null))) clientId = null;
  const data = {
    name,
    phone: text(input.phone, 40),
    email: text(input.email, 200),
    company: text(input.company, 200),
    source: isLeadSource(input.source) ? input.source : "OTHER",
    currency,
    valueMinor: value,
    nextFollowUpAt: followUp,
    notes: text(input.notes, 4000),
    clientId,
  };
  if (id) {
    const updated = await prisma.salesLead.updateMany({ where: { id }, data });
    if (updated.count !== 1) return { error: "That lead no longer exists." };
    await prisma.salesLeadEvent.create({ data: { leadId: id, kind: "EDITED", actorUsername: access.session.username } });
    await revalidate("/sales", `/sales/${id}`);
    return { success: "Lead saved.", id };
  }
  const created = await prisma.$transaction(async (tx) => {
    const lead = await tx.salesLead.create({ data: { ...data, createdByUsername: access.session.username }, select: { id: true } });
    await tx.salesLeadEvent.create({ data: { leadId: lead.id, kind: "CREATED", toStage: "NEW", actorUsername: access.session.username } });
    return lead;
  });
  await revalidate("/sales");
  await emitWebhookEvent("lead.created", { leadId: created.id, name, source: data.source, stage: "NEW" });
  return { success: "Lead added.", id: created.id };
}

/** Move a lead along the pipeline. Lost needs a reason; Won and Lost close it. */
export async function moveLeadStage(id: string, toRaw: string, lostReason: string): Promise<SalesResult> {
  const access = await checkPermission("sales.manage");
  if ("denied" in access) return { error: access.denied };
  if (!isLeadStage(toRaw)) return { error: "Unknown stage." };
  const reason = text(lostReason, 500);
  const refused = validateLeadStageMove(toRaw, reason);
  if (refused) return { error: refused };
  const lead = await prisma.salesLead.findFirst({ where: { id }, select: { stage: true } });
  if (!lead) return { error: "That lead no longer exists." };
  if (lead.stage === toRaw) return { success: `Already ${LEAD_STAGE_LABELS[toRaw].toLowerCase()}.` };
  const closing = toRaw === "WON" || toRaw === "LOST";
  const moved = await prisma.$transaction(async (tx) => {
    const r = await tx.salesLead.updateMany({
      where: { id, stage: lead.stage },
      data: { stage: toRaw, closedAt: closing ? new Date() : null, lostReason: toRaw === "LOST" ? reason : null },
    });
    if (r.count !== 1) return false;
    await tx.salesLeadEvent.create({ data: { leadId: id, kind: "STAGE", fromStage: lead.stage, toStage: toRaw, note: toRaw === "LOST" ? reason : null, actorUsername: access.session.username } });
    return true;
  });
  if (!moved) return { error: "The lead changed while you were looking. Reload and try again." };
  await emitWebhookEvent("lead.stage_changed", { leadId: id, from: lead.stage, to: toRaw });
  await revalidate("/sales", `/sales/${id}`);
  return { success: `Moved to ${LEAD_STAGE_LABELS[toRaw]}.` };
}

export async function addLeadNote(id: string, note: string): Promise<SalesResult> {
  const access = await checkPermission("sales.manage");
  if ("denied" in access) return { error: access.denied };
  const clean = text(note, 2000);
  if (!clean) return { error: "Write the note first." };
  const lead = await prisma.salesLead.findFirst({ where: { id }, select: { id: true } });
  if (!lead) return { error: "That lead no longer exists." };
  await prisma.$transaction([
    prisma.salesLeadEvent.create({ data: { leadId: id, kind: "NOTE", note: clean, actorUsername: access.session.username } }),
    prisma.salesLead.update({ where: { id }, data: { updatedAt: new Date() } }),
  ]);
  await revalidate(`/sales/${id}`);
  return { success: "Note added." };
}

export async function setLeadFollowUp(id: string, when: string): Promise<SalesResult> {
  const access = await checkPermission("sales.manage");
  if ("denied" in access) return { error: access.denied };
  const date = parseFollowUp(String(when ?? ""));
  if (date && Number.isNaN(date.getTime())) return { error: "That is not a valid date." };
  const updated = await prisma.salesLead.updateMany({ where: { id }, data: { nextFollowUpAt: date } });
  if (updated.count !== 1) return { error: "That lead no longer exists." };
  await prisma.salesLeadEvent.create({ data: { leadId: id, kind: "FOLLOW_UP", note: date ? date.toISOString() : "cleared", actorUsername: access.session.username } });
  await revalidate("/sales", `/sales/${id}`);
  return { success: date ? "Follow-up set." : "Follow-up cleared." };
}

/** Delete a lead with no order behind it. A won lead keeps its record. */
export async function deleteLead(id: string): Promise<SalesResult> {
  const access = await checkPermission("sales.manage");
  if ("denied" in access) return { error: access.denied };
  const removed = await prisma.salesLead.deleteMany({ where: { id, wonOrderId: null } });
  if (removed.count !== 1) return { error: "A lead that became an order is kept. Move it to Lost instead, if it should leave the pipeline." };
  await revalidate("/sales");
  return { success: "Lead deleted." };
}
