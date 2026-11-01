import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  consumeRecoveryCode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  otpauthUri,
  totpStep,
  verifyTotp,
} from "@/server/totp";

// RFC 6238 Appendix B: the SHA-1 seed "12345678901234567890", 8-digit values; the last 6 digits are what a
// 6-digit authenticator shows.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const RFC_VECTORS: Array<[number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("TOTP (RFC 6238)", () => {
  it("matches the RFC test vectors", () => {
    for (const [seconds, expected] of RFC_VECTORS) {
      expect(hotp(base32Decode(RFC_SECRET), totpStep(seconds * 1000))).toBe(expected.slice(-6));
    }
  });

  it("base32 round-trips", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(secret))).toBe(secret);
  });

  it("accepts the current code and one step either side, nothing further", () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    const key = base32Decode(RFC_SECRET);
    expect(verifyTotp(RFC_SECRET, hotp(key, step), now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, hotp(key, step - BigInt(1)), now)).toBe(step - BigInt(1));
    expect(verifyTotp(RFC_SECRET, hotp(key, step + BigInt(1)), now)).toBe(step + BigInt(1));
    expect(verifyTotp(RFC_SECRET, hotp(key, step - BigInt(2)), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, hotp(key, step + BigInt(2)), now)).toBeNull();
  });

  it("refuses a code that was already used (replay)", () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    const code = hotp(base32Decode(RFC_SECRET), step);
    expect(verifyTotp(RFC_SECRET, code, now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code, now, step - BigInt(1))).toBe(step);
  });

  it("refuses anything that is not six digits", () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 5"]) expect(verifyTotp(RFC_SECRET, bad, Date.now())).toBeNull();
  });

  it("builds an otpauth address apps can read", () => {
    const uri = otpauthUri("JBSWY3DPEHPK3PXP", "rudra", "Get Assist");
    expect(uri.startsWith("otpauth://totp/Get%20Assist%3Arudra?")).toBe(true);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=Get+Assist");
  });
});

describe("recovery codes", () => {
  it("are ten distinct one-time codes", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
  });

  it("each works once, typed any way", () => {
    const codes = generateRecoveryCodes(3);
    const stored = codes.map(hashRecoveryCode);
    const after = consumeRecoveryCode(stored, ` ${codes[1]!.toUpperCase().replace("-", "")} `);
    expect(after).toEqual([stored[0], stored[2]]);
    expect(consumeRecoveryCode(after!, codes[1]!)).toBeNull();
    expect(consumeRecoveryCode(stored, "wrong-codes")).toBeNull();
  });
});
