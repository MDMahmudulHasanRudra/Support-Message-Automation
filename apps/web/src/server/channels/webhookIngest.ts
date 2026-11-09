import { createHmac } from "node:crypto";
import { assertNeverProvider, classifyMetaWebhookObject, isMetaChannelType, metaProjectAllowed, splitMetaWebhook, splitWhatsAppCloudWebhook, telegramDedupKey, type ChannelType, type MetaChannelType } from "@support-automation/shared";
import type { Prisma } from "@prisma/client";
import { platformPrisma } from "@/server/db";
import { loadWebhookConnection, secretsEqual } from "@/server/channels/connections";

/**
 * Receiving provider webhooks (OMNICHANNEL.md §7). The routes under /api/channels/ call these and
 * return whatever they answer.
 *
 * The whole job is: prove the request came from the provider, cut it into events, and RECORD each
 * one — nothing else happens on the request. Processing (finding the conversation, storing the
 * message, AI, receipts) is the worker's, from `ChannelInboundEvent`, so:
 *   - Meta and Telegram get their acknowledgement in milliseconds (both retry a slow answer);
 *   - a worker that is down or restarting loses nothing — events wait in the table;
 *   - a provider's retry of the same event is harmless: each row carries the provider's own id as a
 *     dedup key under a unique index, and a duplicate insert is skipped.
 *
 * Every write names the project of the connection the URL's key belongs to; the key (24 random
 * bytes) is the only thing that selects a connection, and a body cannot steer an event into another
 * project — an event for an account no connection of that project has is dropped, not stored.
 */

export interface WebhookAnswer {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * A manual (per-connection) Meta or Telegram webhook body. Kept at 1 MB on purpose (docs/meta-expansion
 * A3): a manual connection is one Page or bot, and Meta's 1,000-update batches are the PLATFORM app's
 * case (below). Raising it is a decision for Gate B evidence, not a guess.
 */
export const MAX_WEBHOOK_BYTES = 1_000_000;

const OK: WebhookAnswer = { status: 200, body: "EVENT_RECEIVED" };
const NOT_FOUND: WebhookAnswer = { status: 404, body: "Not found" };
const FORBIDDEN: WebhookAnswer = { status: 403, body: "Forbidden" };

/**
 * Reads a request body, stopping as soon as it passes `maxBytes` — whatever Content-Length claims, and
 * when there is none (a chunked body). `request.arrayBuffer()` holds the whole body in memory before
 * anything can measure it. Null = too large.
 */
export async function readWebhookBody(request: Request, maxBytes: number): Promise<Buffer | null> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/**
 * The shape every Meta webhook body has: a JSON object with an `object` name and an `entry` array. A
 * signed body without it is not something Meta sends; it is answered 400 and nothing is recorded.
 */
function readMetaEnvelope(raw: Buffer): { ok: true; body: Record<string, unknown>; object: string } | { ok: false; answer: WebhookAnswer } {
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return { ok: false, answer: { status: 400, body: "Body is not JSON" } };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, answer: { status: 400, body: "Not a webhook body" } };
  const { object, entry } = body as { object?: unknown; entry?: unknown };
  if (typeof object !== "string" || !/^[a-z_]{1,64}$/.test(object) || !Array.isArray(entry)) return { ok: false, answer: { status: 400, body: "Not a webhook body" } };
  return { ok: true, body: body as Record<string, unknown>, object };
}

/**
 * The channel a Meta body is for, or the answer to give when it is for none we handle (Meta expansion B1,
 * `classifyMetaWebhookObject`). WhatsApp Cloud API bodies are refused by name, so they can never be cut up
 * as Page events. Logged once per process per object; acknowledged, so Meta does not retry it forever.
 */
const reportedObjects = new Set<string>();
function metaChannelOf(object: string, where: string): { type: MetaChannelType } | { answer: WebhookAnswer } {
  const route = classifyMetaWebhookObject(object);
  switch (route.kind) {
    case "CHANNEL":
      return { type: route.type };
    case "UNSUPPORTED":
    case "UNKNOWN":
      if (!reportedObjects.has(object)) {
        reportedObjects.add(object);
        console.warn(`[channels] ${where}: ${route.reason} Acknowledged, nothing recorded. Unsubscribe it in the Meta app, or deploy the release that handles it.`);
      }
      return { answer: OK };
    default:
      return assertNeverProvider(route, "Meta webhook object");
  }
}

/** How often `lastEventAt` is rewritten — a busy Page must not turn every webhook into an UPDATE. */
const LAST_EVENT_RESOLUTION_MS = 60_000;

/** Meta's one-time GET handshake when the callback URL is saved in the app dashboard. */
export async function verifyMetaSubscription(input: { key: string; mode: string | null; token: string | null; challenge: string | null; now?: Date }): Promise<WebhookAnswer> {
  const connection = await loadWebhookConnection(input.key);
  if (!connection || !(isMetaChannelType(connection.type) || connection.type === "WHATSAPP_CLOUD")) return NOT_FOUND;
  if (input.mode !== "subscribe" || !input.challenge || !secretsEqual(input.token, connection.verifyToken)) return FORBIDDEN;
  // The challenge is echoed back verbatim as text/plain — Meta checks the body equals what it sent.
  // Limited to what Meta sends (digits), so this endpoint cannot be used to reflect arbitrary text.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.challenge)) return FORBIDDEN;
  await platformPrisma.channelConnection.update({ where: { id: connection.id }, data: { webhookVerifiedAt: input.now ?? new Date() } });
  return { status: 200, body: input.challenge, contentType: "text/plain" };
}

/** Meta signs the raw body with the app secret: `X-Hub-Signature-256: sha256=<hex>`. */
export function metaSignatureValid(rawBody: Buffer, header: string | null, appSecret: string | null): boolean {
  if (!header || !appSecret || !header.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  return secretsEqual(header.trim().toLowerCase(), expected);
}

export async function ingestMetaWebhook(input: { key: string; rawBody: Buffer; signature: string | null; receivedAt?: Date }): Promise<WebhookAnswer> {
  const receivedAt = input.receivedAt ?? new Date();
  const connection = await loadWebhookConnection(input.key);
  if (connection?.type === "WHATSAPP_CLOUD") return ingestWhatsAppCloud(connection, input.rawBody, input.signature, receivedAt);
  if (!connection || !isMetaChannelType(connection.type)) return NOT_FOUND;
  if (!metaSignatureValid(input.rawBody, input.signature, connection.appSecret)) {
    console.warn(`[channels] Meta webhook with a missing or wrong signature for connection ${connection.id}; refused.`);
    return { status: 401, body: "Invalid signature" };
  }

  const envelope = readMetaEnvelope(input.rawBody);
  if (!envelope.ok) return envelope.answer;
  const channel = metaChannelOf(envelope.object, "manual Meta webhook");
  if ("answer" in channel) return channel.answer;
  const { type } = channel;
  const events = splitMetaWebhook(envelope.body, type, receivedAt) ?? [];
  if (events.length === 0) return OK;

  // One Meta app has ONE callback URL for all its Pages and Instagram accounts, so a body reaching
  // this connection's URL may be for a sibling connection that uses the same app. Each event goes to
  // the connection, in this project, whose account it names; an account nobody connected is dropped.
  const targets = await platformPrisma.channelConnection.findMany({
    where: {
      projectId: connection.projectId,
      type,
      status: { not: "DISCONNECTED" },
      authMode: "MANUAL",
      OR: [{ id: connection.id }, ...(connection.appId ? [{ appId: connection.appId }] : [])],
    },
    select: { id: true, externalAccountId: true },
  });
  const byAccount = new Map(targets.filter((t) => t.externalAccountId).map((t) => [t.externalAccountId!, t.id]));

  const rows: Prisma.ChannelInboundEventCreateManyInput[] = [];
  for (const event of events) {
    const connectionId = event.accountId ? byAccount.get(event.accountId) : undefined;
    if (!connectionId) continue;
    rows.push({
      projectId: connection.projectId,
      connectionId,
      dedupKey: event.dedupKey,
      payload: { provider: "META", type, accountId: event.accountId, item: event.item } as Prisma.InputJsonValue,
      receivedAt,
    });
  }
  await record(rows, receivedAt);
  return OK;
}

/**
 * WhatsApp (Official API) at its own per-connection address (WHATSAPP_OFFICIAL.md). One Meta app can carry several numbers, so each event goes to the
 * connection in this project, on this app, whose phone number id it names. A number nobody connected is dropped.
 */
async function ingestWhatsAppCloud(connection: { id: string; projectId: string; appId: string | null; appSecret: string | null }, rawBody: Buffer, signature: string | null, receivedAt: Date): Promise<WebhookAnswer> {
  if (!metaSignatureValid(rawBody, signature, connection.appSecret)) {
    console.warn(`[channels] WhatsApp webhook with a missing or wrong signature for connection ${connection.id}; refused.`);
    return { status: 401, body: "Invalid signature" };
  }
  const envelope = readMetaEnvelope(rawBody);
  if (!envelope.ok) return envelope.answer;
  if (envelope.object !== "whatsapp_business_account") return OK;
  const events = splitWhatsAppCloudWebhook(envelope.body, receivedAt);
  if (events.length === 0) return OK;
  const targets = await platformPrisma.channelConnection.findMany({
    where: { projectId: connection.projectId, type: "WHATSAPP_CLOUD", status: { not: "DISCONNECTED" }, OR: [{ id: connection.id }, ...(connection.appId ? [{ appId: connection.appId }] : [])] },
    select: { id: true, externalAccountId: true },
  });
  const byAccount = new Map(targets.filter((t) => t.externalAccountId).map((t) => [t.externalAccountId!, t.id]));
  const rows: Prisma.ChannelInboundEventCreateManyInput[] = [];
  for (const event of events) {
    const connectionId = event.accountId ? byAccount.get(event.accountId) : undefined;
    if (!connectionId) continue;
    rows.push({ projectId: connection.projectId, connectionId, dedupKey: event.dedupKey, payload: { provider: "WHATSAPP_CLOUD", accountId: event.accountId, item: event.item } as Prisma.InputJsonValue, receivedAt });
  }
  await record(rows, receivedAt);
  return OK;
}

/** Meta batches up to 1,000 updates in one POST to the platform app's single webhook. */
export const MAX_PLATFORM_WEBHOOK_BYTES = 8_000_000;

/**
 * The PLATFORM app's webhook (docs/meta-integration/05): one URL, one app secret, every customer's
 * Pages. Signed with the platform's app secret, and each event is routed by the ACCOUNT it names to
 * the one live one-click connection holding that account — the database allows at most one across the
 * installation. Nothing in the body can choose a project; an account no one-click connection holds is
 * dropped. Manual connections are never matched here, and this route is never matched for them.
 */
export async function ingestPlatformMetaWebhook(input: { rawBody: Buffer; signature: string | null; appSecret: string; receivedAt?: Date }): Promise<WebhookAnswer> {
  const receivedAt = input.receivedAt ?? new Date();
  if (!metaSignatureValid(input.rawBody, input.signature, input.appSecret)) {
    console.warn("[channels] platform Meta webhook with a missing or wrong signature; refused.");
    return { status: 401, body: "Invalid signature" };
  }
  const envelope = readMetaEnvelope(input.rawBody);
  if (!envelope.ok) return envelope.answer;
  const channel = metaChannelOf(envelope.object, "platform Meta webhook");
  if ("answer" in channel) return channel.answer;
  const { type } = channel;
  const events = splitMetaWebhook(envelope.body, type, receivedAt) ?? [];
  const accountIds = [...new Set(events.map((e) => e.accountId).filter((id): id is string => Boolean(id)))];
  if (accountIds.length === 0) return OK;

  const targets = await platformPrisma.channelConnection.findMany({
    where: { authMode: "PLATFORM", type, status: { not: "DISCONNECTED" }, externalAccountId: { in: accountIds } },
    select: { id: true, projectId: true, externalAccountId: true },
  });
  // Only workspaces on META_ALLOWED_PROJECT_IDS receive anything: a workspace taken off the list stops
  // here, before a single event is recorded for the worker.
  const byAccount = new Map(targets.filter((t) => metaProjectAllowed(process.env, t.projectId)).map((t) => [t.externalAccountId!, t]));
  const rows: Prisma.ChannelInboundEventCreateManyInput[] = [];
  let dropped = 0;
  for (const event of events) {
    const target = event.accountId ? byAccount.get(event.accountId) : undefined;
    if (!target) {
      dropped++;
      continue;
    }
    rows.push({
      projectId: target.projectId,
      connectionId: target.id,
      dedupKey: event.dedupKey,
      payload: { provider: "META", type, accountId: event.accountId, item: event.item } as Prisma.InputJsonValue,
      receivedAt,
    });
  }
  if (dropped > 0) console.warn(`[channels] platform Meta webhook: ${dropped} event(s) for accounts no one-click connection holds; dropped.`);
  await record(rows, receivedAt);
  return OK;
}

export async function ingestTelegramWebhook(input: { key: string; rawBody: Buffer; secret: string | null; receivedAt?: Date }): Promise<WebhookAnswer> {
  const receivedAt = input.receivedAt ?? new Date();
  const connection = await loadWebhookConnection(input.key);
  if (!connection || connection.type !== "TELEGRAM") return NOT_FOUND;
  if (!secretsEqual(input.secret, connection.webhookSecret)) {
    console.warn(`[channels] Telegram webhook with a missing or wrong secret for connection ${connection.id}; refused.`);
    return { status: 401, body: "Invalid secret" };
  }
  let update: unknown;
  try {
    update = JSON.parse(input.rawBody.toString("utf8"));
  } catch {
    return { status: 400, body: "Body is not JSON" };
  }
  const dedupKey = telegramDedupKey(update);
  if (!dedupKey) return OK;
  await record(
    [
      {
        projectId: connection.projectId,
        connectionId: connection.id,
        dedupKey,
        payload: { provider: "TELEGRAM", type: "TELEGRAM" satisfies ChannelType, update } as Prisma.InputJsonValue,
        receivedAt,
      },
    ],
    receivedAt,
  );
  return OK;
}

async function record(rows: Prisma.ChannelInboundEventCreateManyInput[], receivedAt: Date): Promise<void> {
  if (rows.length === 0) return;
  // skipDuplicates: a provider's retry of an event already recorded is a no-op, never an error —
  // answering it with a 500 would only make the provider retry again.
  await platformPrisma.channelInboundEvent.createMany({ data: rows, skipDuplicates: true });
  const ids = [...new Set(rows.map((r) => r.connectionId))];
  await platformPrisma.channelConnection.updateMany({
    where: { id: { in: ids }, OR: [{ lastEventAt: null }, { lastEventAt: { lt: new Date(receivedAt.getTime() - LAST_EVENT_RESOLUTION_MS) } }] },
    data: { lastEventAt: receivedAt },
  });
}
