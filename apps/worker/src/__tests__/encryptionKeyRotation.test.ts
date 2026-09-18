import { afterEach, describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  encryptionKeyIdOf,
  maskSecret,
  reencryptSecret,
} from "@support-automation/db";

/**
 * Key rotation — whether it is a real operation or a claim.
 *
 * It was a claim. The stored envelope was `iv.tag.ciphertext` and named no key, so replacing
 * `AI_CREDENTIALS_ENCRYPTION_KEY` made every stored credential permanently undecryptable: nothing
 * recorded which rows were written under which key, so no migration could be written. "We can
 * rotate the key" was untrue and nothing in the system said so.
 *
 * These prove the four things that make it true: old ciphertext still reads, new ciphertext names
 * its key, a wrong key is REJECTED rather than returning rubbish, and a stored secret can be moved
 * onto the current key.
 *
 * Pure — no database. Encryption is a property of the envelope, not of where it is stored, which
 * is also why this lives in the worker's suite rather than in `packages/db`: that package has no
 * test runner by design, and the functions are exported across the package boundary anyway.
 */

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");
const KEY_C = Buffer.alloc(32, 3).toString("base64");

const ENV_KEYS = [
  "AI_CREDENTIALS_ENCRYPTION_KEY",
  "AI_CREDENTIALS_ENCRYPTION_KEY_ID",
  "AI_CREDENTIALS_ENCRYPTION_KEYS_OLD",
] as const;

const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function useKeys(config: { active: string; activeId?: string; old?: Record<string, string> }) {
  process.env.AI_CREDENTIALS_ENCRYPTION_KEY = config.active;
  if (config.activeId) process.env.AI_CREDENTIALS_ENCRYPTION_KEY_ID = config.activeId;
  else delete process.env.AI_CREDENTIALS_ENCRYPTION_KEY_ID;
  if (config.old) process.env.AI_CREDENTIALS_ENCRYPTION_KEYS_OLD = JSON.stringify(config.old);
  else delete process.env.AI_CREDENTIALS_ENCRYPTION_KEYS_OLD;
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe("round trip", () => {
  it("encrypts and decrypts with the active key", () => {
    useKeys({ active: KEY_A });
    const stored = encryptSecret("sk-live-secret-value");
    expect(stored).not.toContain("sk-live-secret-value");
    expect(decryptSecret(stored)).toBe("sk-live-secret-value");
  });

  it("names the key in the envelope", () => {
    useKeys({ active: KEY_A, activeId: "k2" });
    const stored = encryptSecret("value");
    expect(stored.startsWith("v2.k2.")).toBe(true);
    expect(encryptionKeyIdOf(stored)).toBe("k2");
  });

  it("produces a different ciphertext each time, from the random IV", () => {
    // Two identical secrets must not be recognisable as identical from their stored form.
    useKeys({ active: KEY_A });
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });
});

describe("the legacy envelope still reads", () => {
  it("decrypts a three-part secret written before key ids existed", () => {
    // Every credential stored before this change is in that form. Dropping the path would lock the
    // deployment out of its own AI providers the moment it deployed.
    useKeys({ active: KEY_A });
    const modern = encryptSecret("legacy-value");
    const legacy = modern.split(".").slice(2).join(".");

    expect(legacy.split(".")).toHaveLength(3);
    expect(encryptionKeyIdOf(legacy)).toBe("v1");
    expect(decryptSecret(legacy)).toBe("legacy-value");
  });
});

describe("a wrong key is rejected, never guessed at", () => {
  it("throws rather than returning rubbish when the key does not match", () => {
    // AES-256-GCM authenticates, so this is a property of the cipher rather than a check bolted on
    // — and it is what makes bulk re-encryption safe: a mismatch is loud, not silent corruption.
    useKeys({ active: KEY_A });
    const stored = encryptSecret("value");

    useKeys({ active: KEY_B });
    expect(() => decryptSecret(stored)).toThrow();
  });

  it("names the missing key when nothing can read a secret", () => {
    useKeys({ active: KEY_A, activeId: "k1" });
    const stored = encryptSecret("value");

    // Rotated to a new key without keeping the old one available.
    useKeys({ active: KEY_B, activeId: "k2" });
    expect(() => decryptSecret(stored)).toThrow(/k1/);
  });

  it("refuses a key that is not 32 bytes", () => {
    useKeys({ active: Buffer.alloc(16, 1).toString("base64") });
    expect(() => encryptSecret("value")).toThrow(/32 bytes/);
  });

  it("refuses an unparseable retired-key map", () => {
    useKeys({ active: KEY_A, activeId: "k2" });
    process.env.AI_CREDENTIALS_ENCRYPTION_KEYS_OLD = "not json";
    const stored = `v2.k1.${"AAAA"}.${"AAAA"}.${"AAAA"}`;
    expect(() => decryptSecret(stored)).toThrow(/must be JSON/);
  });
});

describe("rotation, end to end", () => {
  it("reads old secrets and writes new ones under the new key", () => {
    // Step 1: everything is on key A.
    useKeys({ active: KEY_A, activeId: "k1" });
    const writtenUnderA = encryptSecret("provider-api-key");

    // Step 2: rotate — A moves to the retired map, B becomes active.
    useKeys({ active: KEY_B, activeId: "k2", old: { k1: KEY_A } });

    // The old secret still reads...
    expect(decryptSecret(writtenUnderA)).toBe("provider-api-key");
    expect(encryptionKeyIdOf(writtenUnderA)).toBe("k1");

    // ...and anything new is written under the new key, which is the half a "rotation" that keeps
    // encrypting with the old key silently fails to do.
    const writtenUnderB = encryptSecret("another-key");
    expect(encryptionKeyIdOf(writtenUnderB)).toBe("k2");
    expect(decryptSecret(writtenUnderB)).toBe("another-key");
  });

  it("migrates a stored secret onto the active key", () => {
    useKeys({ active: KEY_A, activeId: "k1" });
    const old = encryptSecret("value-to-migrate");

    useKeys({ active: KEY_B, activeId: "k2", old: { k1: KEY_A } });
    const migrated = reencryptSecret(old);

    expect(encryptionKeyIdOf(migrated)).toBe("k2");
    expect(decryptSecret(migrated)).toBe("value-to-migrate");

    // And now the old key can genuinely be retired — the thing that must be TRUE before anyone
    // destroys it, rather than assumed.
    useKeys({ active: KEY_B, activeId: "k2" });
    expect(decryptSecret(migrated)).toBe("value-to-migrate");
  });

  it("migrates a legacy three-part secret too", () => {
    // The first rotation a real deployment performs starts from here, so this is the case that
    // actually matters rather than the tidy one.
    useKeys({ active: KEY_A });
    const legacy = encryptSecret("legacy").split(".").slice(2).join(".");

    useKeys({ active: KEY_C, activeId: "k9", old: { v1: KEY_A } });
    const migrated = reencryptSecret(legacy);

    expect(encryptionKeyIdOf(migrated)).toBe("k9");
    expect(decryptSecret(migrated)).toBe("legacy");
  });

  it("leaves a secret already on the active key untouched, so a bulk run converges", () => {
    useKeys({ active: KEY_A, activeId: "k1" });
    const stored = encryptSecret("value");
    expect(reencryptSecret(stored)).toBe(stored);
  });
});

describe("masking", () => {
  it("never returns the real value", () => {
    expect(maskSecret("sk-1234567890abcdef")).not.toContain("567890abc");
    expect(maskSecret("short")).toBe("••••••••");
  });
});
