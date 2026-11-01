import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Two-step sign-in codes (ACCOUNT_SELF_SERVICE.md): TOTP, RFC 6238 (SHA-1, 6 digits, 30-second steps) —
 * what every authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy) reads
 * from an `otpauth://` address. Node's crypto only; no library.
 */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;
/** One step either side: a phone clock a little off, or a code typed as it rolled over. */
const DRIFT_STEPS = 1;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("Not a base32 secret.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 (RFC 4226's recommended length). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: bigint): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function totpStep(nowMs: number): bigint {
  return BigInt(Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));
}

/**
 * The step a code belongs to, or null. A step at or before `lastUsedStep` is refused, so a code that
 * has already signed somebody in cannot be used again while it is still showing.
 */
export function verifyTotp(secretBase32: string, code: string, nowMs: number, lastUsedStep: bigint | null = null): bigint | null {
  const typed = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(typed)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpStep(nowMs);
  for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift++) {
    const step = current + BigInt(drift);
    if (step < BigInt(0) || (lastUsedStep !== null && step <= lastUsedStep)) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(typed))) return step;
  }
  return null;
}

/** The address an authenticator app reads (typed in as the "setup key", or scanned). */
export function otpauthUri(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** The secret in groups of four, for typing into an app by hand. */
export function formatSecretForTyping(secretBase32: string): string {
  return secretBase32.match(/.{1,4}/g)?.join(" ") ?? secretBase32;
}

// --- Recovery codes -------------------------------------------------------------------------------

export const RECOVERY_CODE_COUNT = 10;

/** Ten one-time codes like "k7m2q-x9p4d". Shown once; only their hashes are stored. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export function normalizeRecoveryCode(code: string): string {
  return String(code ?? "").replace(/[\s-]/g, "").toLowerCase();
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}

/** The stored hashes without the one this code matches, or null when it matches none. */
export function consumeRecoveryCode(storedHashes: readonly string[], code: string): string[] | null {
  if (normalizeRecoveryCode(code).length !== 10) return null;
  const hash = hashRecoveryCode(code);
  const index = storedHashes.indexOf(hash);
  if (index < 0) return null;
  return storedHashes.filter((_, i) => i !== index);
}
