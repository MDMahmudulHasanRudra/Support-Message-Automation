import { cookies } from "next/headers";
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import { redirect } from "next/navigation";
import { prisma } from "@support-automation/db";

const SESSION_COOKIE = "support_automation_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET is not configured.");
  return secret;
}

/** Matches the "salt:hash" scrypt format used by packages/db/prisma/seed.ts. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

function createSessionToken(userId: string): string {
  const payload = `${userId}.${Date.now() + SESSION_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

function verifySessionToken(token: string): { userId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expiryStr, signature] = parts;
  const payload = `${userId}.${expiryStr}`;
  const expected = sign(payload);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return null;
  return { userId };
}

export interface Session {
  userId: string;
  email: string;
  name: string;
}

export async function createSession(userId: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, createSessionToken(userId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const verified = verifySessionToken(token);
  if (!verified) return null;

  const user = await prisma.user.findUnique({ where: { id: verified.userId } });
  if (!user) return null;
  return { userId: user.id, email: user.email, name: user.name };
}

/** Call at the top of any protected server component/page. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}
