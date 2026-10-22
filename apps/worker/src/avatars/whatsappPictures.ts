import {
  avatarsGloballyDisabled,
  isAllowedPictureUrl,
  parseWhatsAppId,
  prepareClientPhoto,
  WHATSAPP_PICTURE_LIMITS,
  type PictureRef,
} from "@support-automation/shared";
import { trackTick } from "../lifecycle.js";
import { platformPrisma, prisma } from "../db.js";
import { currentProjectId, withProject } from "../project/context.js";
import { projectHasFeature } from "../project/features.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import type { RawIncomingMessage } from "../pipeline/types.js";

/**
 * WhatsApp profile pictures and group icons, PASSIVELY (WHATSAPP_AVATARS.md).
 *
 * Only pictures WhatsApp itself attached to an incoming message are used: OpenWA serialises the
 * sender's contact (and, in a group, the group's own contact) onto every event, and that object
 * already carries the picture's address and version tag. Nothing here ever asks WhatsApp for a
 * picture — no profile lookup, no scan, no refresh timer. A picture is fetched once per version, from
 * the address on the event, and only while the project's WHATSAPP_AVATARS feature is on and the
 * server's WHATSAPP_AVATARS_DISABLED emergency switch is off.
 */

const FEATURE = "WHATSAPP_AVATARS" as const;
const LOOP_NAME = "whatsapp-pictures";
/** One fetch per tick, every ten seconds: at most 360 an hour for the whole server. */
const INTERVAL_MS = 10_000;
const FETCH_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000] as const;
/** A picture that could not be fetched is tried again, on a NEW event, at most once a day. */
const FAILED_RETRY_AFTER_MS = 24 * 3_600_000;

const HEADERS = { Origin: "https://web.whatsapp.com", Referer: "https://web.whatsapp.com/" };

/** account|jid → the version last recorded, so a busy chat costs no database work per message. */
const recorded = new Map<string, string>();
const RECORDED_LIMIT = 20_000;

/** The version a reference stands for: WhatsApp's tag, or the address without its signature. */
function versionOf(ref: PictureRef): string {
  return (ref.tag ?? ref.url.split("?")[0]!).slice(0, 500);
}

/**
 * Records the pictures an incoming message carried, for the fetch loop. Called by the pipeline right
 * after the message is stored; one cached feature check, and a write only when a picture is new or
 * changed. NEVER throws: a picture can never cost a message anything.
 */
export async function recordMessagePictures(raw: Pick<RawIncomingMessage, "accountId" | "whatsappGroupId" | "chatId" | "senderJid" | "pictures">): Promise<void> {
  try {
    if (avatarsGloballyDisabled(process.env) || !raw.pictures) return;
    const refs: Array<{ jid: string; ref: PictureRef }> = [];
    if (raw.whatsappGroupId && raw.pictures.group) refs.push({ jid: raw.whatsappGroupId, ref: raw.pictures.group });
    // The sender's own picture, keyed by the id WhatsApp named them by. Never a group, broadcast or
    // channel id, and never a guessed one.
    const person = raw.whatsappGroupId ? raw.senderJid : raw.senderJid ?? raw.chatId;
    const kind = parseWhatsAppId(person)?.kind;
    if (person && raw.pictures.sender && (kind === "LID" || kind === "PHONE")) refs.push({ jid: person, ref: raw.pictures.sender });
    if (refs.length === 0) return;
    if (!(await projectHasFeature(FEATURE))) return;

    const now = new Date();
    for (const { jid, ref } of refs) {
      const key = `${raw.accountId}|${jid}`;
      const version = versionOf(ref);
      if (recorded.get(key) === version) continue;
      const existing = await prisma.whatsAppPicture.findFirst({ where: { accountId: raw.accountId, jid }, select: { sourceTag: true, state: true, updatedAt: true } });
      const unchanged = existing?.sourceTag === version;
      const failedRecently = existing?.state === "FAILED" && now.getTime() - existing.updatedAt.getTime() < FAILED_RETRY_AFTER_MS;
      if (!(unchanged && (existing.state !== "FAILED" || failedRecently))) {
        const queued = { state: "PENDING", sourceTag: version, sourceUrl: ref.url, attempts: 0, lastError: null, observedAt: now, nextAttemptAt: now };
        await prisma.whatsAppPicture.upsert({
          where: { projectId_accountId_jid: { projectId: currentProjectId(), accountId: raw.accountId, jid } },
          create: { accountId: raw.accountId, jid, ...queued },
          // Keeps the picture already stored, so the old one shows until the new one arrives.
          update: queued,
        });
      }
      if (recorded.size >= RECORDED_LIMIT) recorded.clear();
      recorded.set(key, version);
    }
  } catch (err) {
    console.warn("[pictures] could not record a picture (the message is unaffected)", (err as Error).message);
  }
}

export type PictureFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: "manual" }) => Promise<Response>;

/** Reads at most `limit` bytes; more is refused rather than truncated. */
async function readCapped(res: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) throw new Error(`The picture is larger than ${limit} bytes.`);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`The picture is larger than ${limit} bytes.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Fetches and checks one picture: the address must still be allowed, the body small, the type a real image. */
export async function fetchPicture(url: string, fetchImpl: PictureFetch): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (!isAllowedPictureUrl(url)) throw new Error("The picture address is not a WhatsApp picture address.");
  const res = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "manual" });
  if (res.status !== 200) throw new Error(`WhatsApp answered HTTP ${res.status}.`);
  const declaredType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (declaredType && !declaredType.startsWith("image/")) throw new Error(`Not an image (${declaredType}).`);
  const prepared = prepareClientPhoto(await readCapped(res, WHATSAPP_PICTURE_LIMITS.maxBytes));
  if (!prepared.ok) throw new Error(prepared.error);
  if (prepared.bytes.byteLength > WHATSAPP_PICTURE_LIMITS.maxBytes) throw new Error("The picture is too large.");
  return { bytes: prepared.bytes, mimeType: prepared.type };
}

/** Rows ready to fetch, for projects with the feature on. Claimed with a lease so two ticks cannot share one. */
export async function claimDuePictures(limit: number, now: Date = new Date()): Promise<Array<{ id: string; projectId: string }>> {
  if (limit <= 0 || avatarsGloballyDisabled(process.env)) return [];
  const due = await platformPrisma.whatsAppPicture.findMany({
    where: {
      state: "PENDING",
      sourceUrl: { not: null },
      nextAttemptAt: { lte: now },
      project: { status: { in: ["SETUP", "ACTIVE"] }, billingHoldAt: null, features: { some: { key: FEATURE, enabled: true } } },
    },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
    select: { id: true, projectId: true, nextAttemptAt: true },
  });
  const claimed: Array<{ id: string; projectId: string }> = [];
  for (const row of due) {
    const { count } = await platformPrisma.whatsAppPicture.updateMany({
      where: { id: row.id, state: "PENDING", nextAttemptAt: row.nextAttemptAt },
      data: { nextAttemptAt: new Date(now.getTime() + 10 * 60_000), attempts: { increment: 1 } },
    });
    if (count === 1) claimed.push({ id: row.id, projectId: row.projectId });
  }
  return claimed;
}

export async function processPicture(id: string, deps: { fetchImpl?: PictureFetch; now?: () => Date } = {}): Promise<void> {
  const now = deps.now?.() ?? new Date();
  // Re-checked inside the project: switched off since the claim means nothing goes out.
  if (avatarsGloballyDisabled(process.env) || !(await projectHasFeature(FEATURE))) return;
  const row = await prisma.whatsAppPicture.findUnique({ where: { id }, select: { id: true, state: true, sourceUrl: true, attempts: true } });
  if (!row || row.state !== "PENDING" || !row.sourceUrl) return;
  try {
    const picture = await fetchPicture(row.sourceUrl, deps.fetchImpl ?? ((url, init) => fetch(url, init)));
    await prisma.whatsAppPicture.update({
      where: { id },
      data: { state: "STORED", bytes: Buffer.from(picture.bytes), mimeType: picture.mimeType, sourceUrl: null, storedAt: now, lastError: null, nextAttemptAt: null },
    });
  } catch (err) {
    const message = (err as Error).message.slice(0, 300);
    const done = row.attempts >= WHATSAPP_PICTURE_LIMITS.maxAttempts;
    await prisma.whatsAppPicture.update({
      where: { id },
      data: done
        ? { state: "FAILED", sourceUrl: null, lastError: message, nextAttemptAt: null }
        : { lastError: message, nextAttemptAt: new Date(now.getTime() + RETRY_DELAYS_MS[Math.min(row.attempts - 1, RETRY_DELAYS_MS.length - 1)]!) },
    });
  }
}

/** One picture every ten seconds at most, for the whole server. Does nothing under the emergency switch. */
export function startPictureProcessor(intervalMs = INTERVAL_MS): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void trackTick(async () => {
      try {
        for (const row of await claimDuePictures(1)) await withProject(row.projectId, () => processPicture(row.id));
      } catch (err) {
        console.error("[pictures] tick failed", (err as Error).message);
      } finally {
        running = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      }
    });
  }, intervalMs);
}

/** Tests only. */
export function forgetRecordedPicturesForTests(): void {
  recorded.clear();
}
