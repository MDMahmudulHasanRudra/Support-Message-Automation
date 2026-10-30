import { decryptSecret } from "@support-automation/db";
import {
  COURIER_LABELS,
  courierPhone,
  formatMinor,
  isFinalShipmentStatus,
  mapCourierStatus,
  shipmentInvoice,
  SHIPMENT_STATUS_LABELS,
  type CourierProvider,
  type ShipmentStatus,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { emitWebhookEvent } from "@/server/integrationHub/webhooks";
import { courierAdapter, type CourierAdapter, type CourierCredentials, type CourierSettings } from "./courierProviders";
import { ProviderError, ProviderUnknownOutcome } from "./http";

/**
 * Shipments (COMMERCE_INTEGRATIONS.md §Couriers). Called by the page actions and by the background
 * refresh, always inside a project (the scoped client). Never throws for a provider problem: the
 * outcome is written on the shipment and returned as a sentence.
 */

export class ShipmentRefusal extends Error {}

/** The adapter for a connection of this project, or a refusal sentence. */
export async function adapterForConnection(connectionId: string): Promise<{ adapter: CourierAdapter; provider: CourierProvider; id: string } | { refused: string }> {
  const c = await prisma.courierConnection.findFirst({ where: { id: connectionId } });
  if (!c) return { refused: "That courier connection no longer exists." };
  if (!c.isActive) return { refused: `${COURIER_LABELS[c.provider]} is switched off for this project.` };
  let credentials: CourierCredentials;
  try {
    credentials = JSON.parse(decryptSecret(c.credentialsCiphertext)) as CourierCredentials;
  } catch {
    return { refused: `The saved ${COURIER_LABELS[c.provider]} credentials cannot be read. Enter them again.` };
  }
  return { adapter: courierAdapter(c.provider, credentials, (c.settings ?? {}) as CourierSettings, c.sandbox), provider: c.provider, id: c.id };
}

export interface BookShipmentInput {
  orderId: string;
  connectionId: string;
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
  cod: bigint;
  note: string | null;
  areaId?: string | null;
  areaName?: string | null;
  actor: string;
}

/**
 * Book a parcel for an order. The shipment row is written FIRST (BOOKING) — its unique invoice and the
 * one-live-shipment-per-order index are what stop a double booking — then the courier is called once.
 * Booked: the order becomes Shipped. Refused by the courier: FAILED, and the order may be booked again.
 * No answer: UNKNOWN — never retried by itself; a person checks the courier's panel.
 */
export async function bookShipment(input: BookShipmentInput): Promise<{ status: ShipmentStatus; message: string; shipmentId: string }> {
  const order = await prisma.commerceOrder.findFirst({ where: { id: input.orderId }, include: { items: { select: { name: true, quantity: true } }, _count: { select: { shipments: true } } } });
  if (!order) throw new ShipmentRefusal("That order no longer exists.");
  if (order.status !== "CONFIRMED" && order.status !== "PROCESSING") throw new ShipmentRefusal("Only a confirmed or processing order can be sent with a courier.");
  const phone = courierPhone(input.recipientPhone);
  if (!phone) throw new ShipmentRefusal("Couriers need an 11-digit Bangladeshi mobile number, like 01712345678.");
  const name = input.recipientName.trim().slice(0, 100);
  const address = input.recipientAddress.trim().replace(/\s+/g, " ").slice(0, 250);
  if (!name) throw new ShipmentRefusal("Enter the recipient's name.");
  if (address.length < 10) throw new ShipmentRefusal("Enter the full delivery address (at least 10 characters).");
  if (input.cod < BigInt(0) || input.cod > order.totalMinor) throw new ShipmentRefusal(`The amount to collect must be between 0 and the order total (${formatMinor(order.totalMinor, order.currency)}).`);
  const resolved = await adapterForConnection(input.connectionId);
  if ("refused" in resolved) throw new ShipmentRefusal(resolved.refused);

  const invoice = shipmentInvoice(order.number, order._count.shipments + 1);
  let shipmentId: string;
  try {
    const created = await prisma.shipment.create({
      data: {
        orderId: order.id,
        connectionId: resolved.id,
        provider: resolved.provider,
        status: "BOOKING",
        invoice,
        codAmountMinor: input.cod,
        currency: order.currency,
        recipientName: name,
        recipientPhone: phone,
        recipientAddress: address,
        note: input.note,
        details: input.areaId ? { areaId: input.areaId, areaName: input.areaName } : undefined,
        bookedByUsername: input.actor,
        events: { create: { status: "BOOKING", note: `Sent to ${COURIER_LABELS[resolved.provider]}`, actorUsername: input.actor } },
      },
      select: { id: true },
    });
    shipmentId = created.id;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ShipmentRefusal("This order already has a shipment being booked or on its way.");
    throw err;
  }

  const itemCount = order.items.reduce((n, i) => n + i.quantity, 0);
  try {
    const booked = await resolved.adapter.book({
      invoice,
      recipientName: name,
      recipientPhone: phone,
      recipientAddress: address,
      codAmountMinor: input.cod,
      orderValueMinor: order.totalMinor,
      itemCount: Math.max(1, itemCount),
      itemDescription: order.items.map((i) => `${i.quantity}× ${i.name}`).join(", ").slice(0, 250),
      note: input.note,
      areaId: input.areaId,
      areaName: input.areaName,
    });
    const status = booked.providerStatus ? mapCourierStatus(resolved.provider, booked.providerStatus) : "BOOKED";
    const settled: ShipmentStatus = status === "UNKNOWN" ? "BOOKED" : status;
    await prisma.$transaction(async (tx) => {
      await tx.shipment.update({
        where: { id: shipmentId },
        data: {
          status: settled,
          providerStatus: booked.providerStatus,
          consignmentId: booked.consignmentId,
          trackingCode: booked.trackingCode,
          bookedAt: new Date(),
          lastCheckedAt: new Date(),
          details: { ...(input.areaId ? { areaId: input.areaId, areaName: input.areaName } : {}), ...booked.details } as object,
        },
      });
      await tx.shipmentEvent.create({ data: { shipmentId, status: settled, providerStatus: booked.providerStatus, note: `Booked: ${booked.consignmentId ?? "no id returned"}`, actorUsername: input.actor } });
      const moved = await tx.commerceOrder.updateMany({ where: { id: order.id, status: { in: ["CONFIRMED", "PROCESSING"] } }, data: { status: "SHIPPED" } });
      if (moved.count === 1) {
        await tx.commerceOrderEvent.create({
          data: { orderId: order.id, kind: "STATUS", fromStatus: order.status, toStatus: "SHIPPED", detail: { note: `${COURIER_LABELS[resolved.provider]} ${booked.consignmentId ?? ""}`.trim(), shipmentId }, actorUsername: input.actor },
        });
      }
    });
    await emitWebhookEvent("shipment.status_changed", { shipmentId, orderId: order.id, order: order.number, courier: resolved.provider, status: settled, consignmentId: booked.consignmentId });
    return { status: settled, shipmentId, message: `Booked with ${COURIER_LABELS[resolved.provider]}${booked.consignmentId ? ` (${booked.consignmentId})` : ""}. The order is now shipped.` };
  } catch (err) {
    const unknown = err instanceof ProviderUnknownOutcome;
    const message = err instanceof ProviderError || unknown ? err.message : "The booking could not be completed.";
    if (!(err instanceof ProviderError) && !unknown) console.error("[courier] booking failed", (err as Error).name);
    const status: ShipmentStatus = unknown ? "UNKNOWN" : "FAILED";
    await prisma.shipment.update({ where: { id: shipmentId }, data: { status, error: message } });
    await prisma.shipmentEvent.create({ data: { shipmentId, status, note: message, actorUsername: input.actor } });
    return {
      status,
      shipmentId,
      message: unknown
        ? `${message} The parcel may or may not have been booked: check ${COURIER_LABELS[resolved.provider]}'s panel for invoice ${invoice}, then record what you find.`
        : `Not booked: ${message}`,
    };
  }
}

/**
 * Read the courier's current status and record it if it changed. Delivered moves the order to
 * Delivered; a return is recorded on the shipment only — putting stock back is a person's decision
 * (Mark returned on the order).
 */
export async function refreshShipment(shipmentId: string, actor: string | null): Promise<{ changed: boolean; status: ShipmentStatus; message: string }> {
  const s = await prisma.shipment.findFirst({ where: { id: shipmentId }, select: { id: true, status: true, provider: true, connectionId: true, consignmentId: true, trackingCode: true, invoice: true, orderId: true, providerStatus: true } });
  if (!s) throw new ShipmentRefusal("That shipment no longer exists.");
  if (s.status === "BOOKING" || s.status === "FAILED") return { changed: false, status: s.status, message: "There is nothing to look up for this shipment." };
  if (!s.connectionId) throw new ShipmentRefusal("The courier connection was removed, so the status cannot be read.");
  const resolved = await adapterForConnection(s.connectionId);
  if ("refused" in resolved) throw new ShipmentRefusal(resolved.refused);
  let raw: string;
  try {
    raw = await resolved.adapter.status({ consignmentId: s.consignmentId, trackingCode: s.trackingCode, invoice: s.invoice });
  } catch (err) {
    const message = err instanceof ProviderError || err instanceof ProviderUnknownOutcome ? err.message : "The status could not be read.";
    await prisma.shipment.update({ where: { id: s.id }, data: { lastCheckedAt: new Date(), error: message } });
    return { changed: false, status: s.status, message };
  }
  const mapped = mapCourierStatus(s.provider, raw);
  // A parcel we could not place in our vocabulary keeps its last known status; the raw text is still shown.
  const next: ShipmentStatus = mapped === "UNKNOWN" && s.status !== "UNKNOWN" ? s.status : mapped === "UNKNOWN" ? "BOOKED" : mapped;
  const changed = next !== s.status || raw !== s.providerStatus;
  await prisma.$transaction(async (tx) => {
    await tx.shipment.update({
      where: { id: s.id },
      data: { status: next, providerStatus: raw, lastCheckedAt: new Date(), error: null, ...(next === "DELIVERED" || next === "PARTIAL_DELIVERED" ? { deliveredAt: new Date() } : {}) },
    });
    if (changed) await tx.shipmentEvent.create({ data: { shipmentId: s.id, status: next, providerStatus: raw, actorUsername: actor } });
    if (changed && (next === "DELIVERED" || next === "PARTIAL_DELIVERED")) {
      const moved = await tx.commerceOrder.updateMany({ where: { id: s.orderId, status: "SHIPPED" }, data: { status: "DELIVERED" } });
      if (moved.count === 1) {
        await tx.commerceOrderEvent.create({
          data: { orderId: s.orderId, kind: "STATUS", fromStatus: "SHIPPED", toStatus: "DELIVERED", detail: { note: `${COURIER_LABELS[s.provider]}: ${raw}`, shipmentId: s.id }, actorUsername: actor ?? "courier-sync" },
        });
      }
    }
  });
  if (changed && next !== s.status) await emitWebhookEvent("shipment.status_changed", { shipmentId: s.id, orderId: s.orderId, courier: s.provider, status: next, courierStatus: raw, consignmentId: s.consignmentId });
  return { changed, status: next, message: `${COURIER_LABELS[s.provider]} says “${raw}” (${SHIPMENT_STATUS_LABELS[next].toLowerCase()}).` };
}

/**
 * A person records what the courier's panel shows for a shipment whose booking outcome was unknown,
 * or marks a shipment cancelled at the courier. Never calls the courier.
 */
export async function recordShipmentOutcome(shipmentId: string, outcome: "BOOKED" | "FAILED" | "CANCELLED", reference: string | null, note: string | null, actor: string): Promise<string> {
  const s = await prisma.shipment.findFirst({ where: { id: shipmentId }, select: { id: true, status: true, orderId: true, provider: true } });
  if (!s) throw new ShipmentRefusal("That shipment no longer exists.");
  if (outcome === "CANCELLED" ? isFinalShipmentStatus(s.status as ShipmentStatus) : s.status !== "UNKNOWN") {
    throw new ShipmentRefusal(outcome === "CANCELLED" ? "This shipment is already closed." : "Only a shipment whose booking outcome is unknown can be resolved this way.");
  }
  if (outcome === "BOOKED" && !reference) throw new ShipmentRefusal("Enter the consignment or tracking id from the courier's panel.");
  await prisma.$transaction(async (tx) => {
    const moved = await tx.shipment.updateMany({
      where: { id: s.id, status: s.status },
      data: { status: outcome, error: null, ...(outcome === "BOOKED" ? { consignmentId: reference, trackingCode: reference, bookedAt: new Date() } : {}) },
    });
    if (moved.count !== 1) throw new ShipmentRefusal("The shipment changed while you were looking. Reload and try again.");
    await tx.shipmentEvent.create({ data: { shipmentId: s.id, status: outcome, note: note ?? (outcome === "BOOKED" ? `Recorded from the courier's panel: ${reference}` : "Recorded by hand"), actorUsername: actor } });
    if (outcome === "BOOKED") {
      const order = await tx.commerceOrder.findFirst({ where: { id: s.orderId }, select: { status: true } });
      if (order && (order.status === "CONFIRMED" || order.status === "PROCESSING")) {
        await tx.commerceOrder.update({ where: { id: s.orderId }, data: { status: "SHIPPED" } });
        await tx.commerceOrderEvent.create({ data: { orderId: s.orderId, kind: "STATUS", fromStatus: order.status, toStatus: "SHIPPED", detail: { note: `${COURIER_LABELS[s.provider]} ${reference}`, shipmentId: s.id }, actorUsername: actor } });
      }
    }
  });
  return outcome === "BOOKED" ? "Recorded as booked. The order is now shipped." : outcome === "FAILED" ? "Recorded as not booked. The order can be booked again." : "Recorded as cancelled.";
}
