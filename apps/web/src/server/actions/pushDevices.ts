"use server";

import { headers } from "next/headers";
import { currentSessionId, getSession } from "@/server/auth";
import { globalPrisma } from "@/server/db";
import { deviceLabel, isAllowedPushEndpoint, type PushPrefs } from "@/lib/pushRules";
import { pushConfigured, sendPush, vapidPublicKey } from "@/server/push/send";

const MAX_DEVICES_PER_PERSON = 10;

export interface PushState {
  available: boolean;
  publicKey: string | null;
  /** This browser's saved choices, when it is registered to this person. */
  prefs: PushPrefs | null;
}

const PREF_SELECT = { notifyAssigned: true, notifyCustomerMessages: true, notifyMentions: true, notifyWaiting: true, showPreview: true } as const;

/** Whether notifications can be offered here, and what this browser chose. Self only. */
export async function getPushState(endpoint: string | null): Promise<PushState> {
  const session = await getSession();
  const available = pushConfigured() && Boolean(session) && !session?.support;
  if (!session || !available) return { available: false, publicKey: null, prefs: null };
  const device = endpoint ? await globalPrisma.pushDevice.findFirst({ where: { endpoint, userId: session.userId }, select: PREF_SELECT }) : null;
  return { available, publicKey: vapidPublicKey(), prefs: device };
}

/**
 * Registers this browser to the person and sign-in using it. Also how an existing browser moves to a new
 * sign-in, so a phone handed to a colleague stops receiving the first person's alerts. A support session
 * never registers: it is an operator looking at a customer's software, not one of their staff.
 */
export async function savePushDevice(subscription: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }): Promise<{ error?: string; prefs?: PushPrefs }> {
  const session = await getSession();
  if (!session || session.support) return { error: "Sign in to turn on notifications." };
  if (!pushConfigured()) return { error: "Notifications are not switched on for this installation yet." };
  const sessionId = await currentSessionId();
  if (!sessionId) return { error: "Sign in to turn on notifications." };
  const { endpoint, keys } = subscription;
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (!isAllowedPushEndpoint(endpoint) || typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 256 || auth.length > 128) {
    return { error: "This browser's notification details could not be read. Try again." };
  }
  const label = deviceLabel((await headers()).get("user-agent"));
  const device = await globalPrisma.pushDevice.upsert({
    where: { endpoint },
    create: { userId: session.userId, sessionId, endpoint, p256dh, auth, label },
    update: { userId: session.userId, sessionId, p256dh, auth, label, failureCount: 0 },
    select: PREF_SELECT,
  });
  const extras = await globalPrisma.pushDevice.findMany({ where: { userId: session.userId }, orderBy: { updatedAt: "desc" }, skip: MAX_DEVICES_PER_PERSON, select: { id: true } });
  if (extras.length) await globalPrisma.pushDevice.deleteMany({ where: { id: { in: extras.map((d) => d.id) } } });
  return { prefs: device };
}

export async function updatePushPrefs(endpoint: string, prefs: Partial<PushPrefs>): Promise<{ error?: string }> {
  const session = await getSession();
  if (!session) return { error: "Sign in to change this." };
  const data: Partial<PushPrefs> = {};
  for (const key of ["notifyAssigned", "notifyCustomerMessages", "notifyMentions", "notifyWaiting", "showPreview"] as const) {
    if (typeof prefs[key] === "boolean") data[key] = prefs[key];
  }
  const done = await globalPrisma.pushDevice.updateMany({ where: { endpoint, userId: session.userId }, data });
  return done.count ? {} : { error: "Turn notifications on first." };
}

export async function removePushDevice(endpoint: string): Promise<void> {
  const session = await getSession();
  if (session) await globalPrisma.pushDevice.deleteMany({ where: { endpoint, userId: session.userId } });
}

/** A real notification to this browser, so a person can see it works and how it looks. */
export async function sendTestPush(endpoint: string): Promise<{ error?: string }> {
  const session = await getSession();
  if (!session) return { error: "Sign in to send a test." };
  const device = await globalPrisma.pushDevice.findFirst({ where: { endpoint, userId: session.userId }, select: { id: true, endpoint: true, p256dh: true, auth: true } });
  if (!device) return { error: "Turn notifications on first." };
  const outcome = await sendPush(device, { title: "Notifications are on", body: "This is how a customer alert will arrive.", url: "/open", tag: "test" });
  return outcome === "sent" ? {} : { error: "The notification could not be sent. Turn notifications off and on again." };
}
