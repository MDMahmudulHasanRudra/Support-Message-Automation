"use server";

import { revalidatePath } from "next/cache";
import { decryptSecret, encryptSecret } from "@support-automation/db";
import { COURIER_CREDENTIAL_FIELDS, COURIER_LABELS, isCourierProvider, toMinor, type CourierProvider } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { adapterForConnection, bookShipment, recordShipmentOutcome, refreshShipment, ShipmentRefusal } from "@/server/integrations/shipments";
import { ProviderError, ProviderUnknownOutcome } from "@/server/integrations/http";

/**
 * Courier actions (COMMERCE_INTEGRATIONS.md §Couriers). Connections need `couriers.manage`; booking and
 * refreshing shipments need `shipments.manage`. Credentials are write-only: saved encrypted, never sent
 * back to the browser.
 */

export interface CourierResult {
  error?: string;
  success?: string;
  id?: string;
}

async function revalidate(...paths: string[]) {
  for (const p of paths) revalidatePath(await projectPath(p));
}

export interface CourierConnectionInput {
  provider: string;
  label: string;
  sandbox: boolean;
  /** Empty fields keep the saved value when editing. */
  credentials: Record<string, string>;
  storeId: string;
  weight: string;
  pickupStoreId: string;
  isActive: boolean;
}

export async function saveCourierConnection(input: CourierConnectionInput): Promise<CourierResult> {
  const access = await checkPermission("couriers.manage");
  if ("denied" in access) return { error: access.denied };
  if (!isCourierProvider(input.provider)) return { error: "Choose a courier." };
  const provider: CourierProvider = input.provider;
  const existing = await prisma.courierConnection.findFirst({ where: { provider } });
  let saved: Record<string, string> = {};
  if (existing) {
    try {
      saved = JSON.parse(decryptSecret(existing.credentialsCiphertext)) as Record<string, string>;
    } catch {
      saved = {};
    }
  }
  const credentials: Record<string, string> = {};
  for (const field of COURIER_CREDENTIAL_FIELDS[provider]) {
    const typed = String(input.credentials?.[field.key] ?? "").trim();
    const value = typed || saved[field.key] || "";
    if (!value) return { error: `Enter the ${field.label}.` };
    if (value.length > 500) return { error: `The ${field.label} is too long.` };
    credentials[field.key] = value;
  }
  if (provider === "PATHAO" && input.storeId.trim() && !/^\d{1,12}$/.test(input.storeId.trim())) return { error: "The Pathao store id is a number." };
  if (provider === "REDX" && input.pickupStoreId.trim() && !/^\d{1,12}$/.test(input.pickupStoreId.trim())) return { error: "The RedX pickup store id is a number." };
  const weight = input.weight.trim();
  if (weight && !(Number(weight) > 0)) return { error: "The default weight must be a positive number." };
  const settings = { storeId: input.storeId.trim() || undefined, weight: weight || undefined, pickupStoreId: input.pickupStoreId.trim() || undefined };
  const data = {
    label: input.label.trim().slice(0, 80) || COURIER_LABELS[provider],
    sandbox: Boolean(input.sandbox) && provider !== "STEADFAST",
    credentialsCiphertext: encryptSecret(JSON.stringify(credentials)),
    settings,
    isActive: Boolean(input.isActive),
  };
  const row = existing
    ? await prisma.courierConnection.update({ where: { id: existing.id }, data: { ...data, lastCheckOk: null, lastError: null } })
    : await prisma.courierConnection.create({ data: { ...data, provider, createdByUsername: access.session.username } });
  await logSystemEvent("INFO", "commerce", `${COURIER_LABELS[provider]} connection ${existing ? "updated" : "added"}`, { provider, by: access.session.username }, { actorUserId: access.session.userId, targetType: "CourierConnection", targetId: row.id });
  await revalidate("/settings/couriers");
  return { success: `${COURIER_LABELS[provider]} saved. Test it to confirm the account works.`, id: row.id };
}

export async function testCourierConnection(connectionId: string): Promise<CourierResult> {
  const access = await checkPermission("couriers.manage");
  if ("denied" in access) return { error: access.denied };
  const resolved = await adapterForConnection(connectionId);
  if ("refused" in resolved) return { error: resolved.refused };
  try {
    const message = await resolved.adapter.test();
    await prisma.courierConnection.update({ where: { id: connectionId }, data: { lastCheckedAt: new Date(), lastCheckOk: true, lastError: null } });
    await revalidate("/settings/couriers");
    return { success: message };
  } catch (err) {
    const message = err instanceof ProviderError || err instanceof ProviderUnknownOutcome ? err.message : "The test could not be completed.";
    await prisma.courierConnection.update({ where: { id: connectionId }, data: { lastCheckedAt: new Date(), lastCheckOk: false, lastError: message } });
    await revalidate("/settings/couriers");
    return { error: message };
  }
}

/** Remove a connection. Its shipments are kept, with their courier ids; they just stop refreshing. */
export async function removeCourierConnection(connectionId: string): Promise<CourierResult> {
  const access = await checkPermission("couriers.manage");
  if ("denied" in access) return { error: access.denied };
  const row = await prisma.courierConnection.findFirst({ where: { id: connectionId }, select: { id: true, provider: true } });
  if (!row) return { error: "That connection no longer exists." };
  await prisma.courierConnection.delete({ where: { id: row.id } });
  await logSystemEvent("INFO", "commerce", `${COURIER_LABELS[row.provider]} connection removed`, { provider: row.provider, by: access.session.username }, { actorUserId: access.session.userId, targetType: "CourierConnection", targetId: row.id });
  await revalidate("/settings/couriers");
  return { success: `${COURIER_LABELS[row.provider]} removed. Its shipments are kept.` };
}

/** RedX delivery areas matching a search, for the booking form. */
export async function searchCourierAreas(connectionId: string, query: string): Promise<{ areas: Array<{ id: string; name: string; district: string | null }>; error?: string }> {
  const access = await checkPermission("shipments.manage");
  if ("denied" in access) return { areas: [], error: access.denied };
  const resolved = await adapterForConnection(connectionId);
  if ("refused" in resolved) return { areas: [], error: resolved.refused };
  if (!resolved.adapter.areas) return { areas: [] };
  try {
    const q = query.trim().toLowerCase();
    const all = await resolved.adapter.areas();
    return { areas: all.filter((a) => !q || a.name.toLowerCase().includes(q) || (a.district ?? "").toLowerCase().includes(q)).slice(0, 50) };
  } catch (err) {
    return { areas: [], error: err instanceof Error ? err.message : "The areas could not be read." };
  }
}

export interface BookInput {
  connectionId: string;
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
  cod: string;
  note: string;
  areaId: string;
  areaName: string;
}

export async function bookOrderShipment(orderId: string, input: BookInput): Promise<CourierResult> {
  const access = await checkPermission("shipments.manage");
  if ("denied" in access) return { error: access.denied };
  const cod = String(input.cod ?? "").trim() ? toMinor(String(input.cod)) : BigInt(0);
  if (cod === null) return { error: "The amount to collect must be a number with at most two decimals." };
  try {
    const r = await bookShipment({
      orderId,
      connectionId: input.connectionId,
      recipientName: input.recipientName,
      recipientPhone: input.recipientPhone,
      recipientAddress: input.recipientAddress,
      cod,
      note: String(input.note ?? "").trim().slice(0, 250) || null,
      areaId: input.areaId || null,
      areaName: input.areaName || null,
      actor: access.session.username,
    });
    await revalidate(`/commerce/orders/${orderId}`, "/commerce/orders", "/commerce/shipments");
    return r.status === "FAILED" || r.status === "UNKNOWN" ? { error: r.message, id: r.shipmentId } : { success: r.message, id: r.shipmentId };
  } catch (err) {
    if (err instanceof ShipmentRefusal) return { error: err.message };
    throw err;
  }
}

export async function refreshOrderShipment(shipmentId: string): Promise<CourierResult> {
  const access = await checkPermission("shipments.manage");
  if ("denied" in access) return { error: access.denied };
  try {
    const r = await refreshShipment(shipmentId, access.session.username);
    await revalidate("/commerce/shipments", "/commerce/orders");
    return { success: r.message };
  } catch (err) {
    if (err instanceof ShipmentRefusal) return { error: err.message };
    throw err;
  }
}

export async function resolveShipment(shipmentId: string, outcome: string, reference: string, note: string): Promise<CourierResult> {
  const access = await checkPermission("shipments.manage");
  if ("denied" in access) return { error: access.denied };
  if (outcome !== "BOOKED" && outcome !== "FAILED" && outcome !== "CANCELLED") return { error: "Choose what the courier's panel shows." };
  try {
    const message = await recordShipmentOutcome(shipmentId, outcome, String(reference ?? "").trim().slice(0, 64) || null, String(note ?? "").trim().slice(0, 250) || null, access.session.username);
    await revalidate("/commerce/shipments", "/commerce/orders");
    return { success: message };
  } catch (err) {
    if (err instanceof ShipmentRefusal) return { error: err.message };
    throw err;
  }
}
