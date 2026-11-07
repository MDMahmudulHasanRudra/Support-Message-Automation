import { globalPrisma } from "@/server/db";

export function pushConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

export interface PushTarget {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Sends one notification. A seam so a test can see what would go out without reaching a push service. */
export type PushSender = (target: PushTarget, message: PushMessage) => Promise<void>;

/** The status a push service answered with, when it answered at all. */
function statusOf(err: unknown): number | null {
  const code = (err as { statusCode?: unknown })?.statusCode;
  return typeof code === "number" ? code : null;
}

const realSender: PushSender = async (target, message) => {
  const webpush = (await import("web-push")).default;
  await webpush.sendNotification(
    { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
    JSON.stringify(message),
    {
      TTL: 3600,
      urgency: "high",
      timeout: 10_000,
      vapidDetails: { subject: process.env.VAPID_SUBJECT || "mailto:support@getassist.pro", publicKey: process.env.VAPID_PUBLIC_KEY!, privateKey: process.env.VAPID_PRIVATE_KEY! },
    },
  );
};

let sender: PushSender = realSender;
export function setPushSenderForTests(next: PushSender | null): void {
  sender = next ?? realSender;
}

const MAX_FAILURES = 20;

/** Never throws, and never logs an address: a push endpoint works as a credential. A device its browser has dropped is removed. */
export async function sendPush(target: PushTarget, message: PushMessage): Promise<"sent" | "gone" | "failed"> {
  try {
    await sender(target, message);
    await globalPrisma.pushDevice.update({ where: { id: target.id }, data: { lastSuccessAt: new Date(), failureCount: 0 } }).catch(() => {});
    return "sent";
  } catch (err) {
    const status = statusOf(err);
    if (status === 404 || status === 410) {
      await globalPrisma.pushDevice.delete({ where: { id: target.id } }).catch(() => {});
      return "gone";
    }
    console.error("[push] send failed", status ?? (err as Error).name);
    const updated = await globalPrisma.pushDevice.update({ where: { id: target.id }, data: { failureCount: { increment: 1 } }, select: { failureCount: true } }).catch(() => null);
    if (updated && updated.failureCount >= MAX_FAILURES) await globalPrisma.pushDevice.delete({ where: { id: target.id } }).catch(() => {});
    return "failed";
  }
}
