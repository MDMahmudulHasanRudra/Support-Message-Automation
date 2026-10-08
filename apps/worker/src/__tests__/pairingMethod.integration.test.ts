import "./helpers/requireTestDatabase.js";
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "./helpers/projectFixtures.js";
import { readPairingPreference } from "../provider/openwa/connectionState.js";
import { processOneCommand } from "../commands/commandProcessor.js";
import { MockProvider } from "./mockProvider.js";

/**
 * Which of WhatsApp's two linking methods an account connects with.
 *
 * Both are official WhatsApp Web flows and `@open-wa/wa-automate@4.76.0` supports both:
 * `ConfigObject.linkCode` selects the second, and the library's initializer races one or the
 * other and never both — `if (config?.linkCode) race.push(linkCode(...)) else race.push(smartQr(...))`.
 *
 * This is the half of that decision our code owns. It cannot test the pairing itself, which needs
 * a real phone and a person holding it; it tests that the worker asks for the right method, and —
 * more importantly — that it never ends up asking for NOTHING, which is what a naive
 * "PHONE_CODE means send linkCode" would do to an account whose number was never filled in.
 */

const createdAccountIds: string[] = [];

async function account(overrides: Record<string, unknown> = {}) {
  const row = await prisma.whatsAppAccount.create({
    data: { label: `Pairing Test ${randomUUID()}`, status: "DISCONNECTED", ...overrides },
  });
  createdAccountIds.push(row.id);
  return row;
}

afterEach(async () => {
  if (createdAccountIds.length) {
    await prisma.whatsAppAccount.deleteMany({ where: { id: { in: createdAccountIds } } });
    createdAccountIds.length = 0;
  }
});

describe("pairing method", () => {
  it("defaults to the QR code, so an existing account is untouched by this feature", async () => {
    const row = await account();
    expect(row.pairingMethod).toBe("QR_CODE");
    expect(await readPairingPreference(row.id)).toEqual({ method: "QR_CODE" });
  });

  it("asks for a link code, digits only, when that is what was chosen", async () => {
    // Stored with punctuation the way a person types it; `ConfigObject.linkCode` documents a bare
    // number ("1234567890"), and handing WhatsApp a "+" would burn the attempt.
    const row = await account({ pairingMethod: "PHONE_CODE", pairingPhoneNumber: "+880 1711-111111" });
    expect(await readPairingPreference(row.id)).toEqual({
      method: "PHONE_CODE",
      linkCodeNumber: "8801711111111",
    });
  });

  it("falls back to a QR code when phone pairing was chosen but no number was saved", async () => {
    // The failure this prevents is silent and total: a link code requested for nothing produces
    // no code AND no QR, leaving an account with no way at all to be linked. A QR the operator
    // did not pick is still scannable.
    const row = await account({ pairingMethod: "PHONE_CODE", pairingPhoneNumber: null });
    expect(await readPairingPreference(row.id)).toEqual({ method: "QR_CODE" });
  });

  it("falls back to a QR code for a number too short to be one", async () => {
    const row = await account({ pairingMethod: "PHONE_CODE", pairingPhoneNumber: "12345" });
    expect(await readPairingPreference(row.id)).toEqual({ method: "QR_CODE" });
  });

  it("falls back to a QR code for an account that no longer exists", async () => {
    // Reached in practice by a connect attempt racing a deletion. It must not throw: the caller is
    // mid-connect, and an exception there fails the whole attempt rather than one setting lookup.
    expect(await readPairingPreference(randomUUID())).toEqual({ method: "QR_CODE" });
  });

  it("forgets the number to pair with when the account is logged out", async () => {
    // Logging out exists so a DIFFERENT number can be linked here. A leftover pairing number means
    // the next attempt quietly requests a link code for the number that just left and presents it
    // as though it were for the new one — wrong, and invisible.
    const row = await account({
      pairingMethod: "PHONE_CODE",
      pairingPhoneNumber: "8801711111111",
      phoneNumber: "+8801711111111",
      status: "CONNECTED",
    });

    const provider = new MockProvider();
    await prisma.workerCommand.create({ data: { type: "LOGOUT", accountId: row.id } });
    await processOneCommand(row.id, provider);

    const after = await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.phoneNumber).toBeNull();
    expect(after.pairingPhoneNumber).toBeNull();
    // The PREFERENCE survives: it describes how this operator links, not which number. With no
    // number saved it falls back to a QR rather than stranding the account.
    expect(after.pairingMethod).toBe("PHONE_CODE");
    expect(await readPairingPreference(row.id)).toEqual({ method: "QR_CODE" });
  });

  it("keeps the confirmed session number separate from the number being paired", async () => {
    // `phoneNumber` is what WhatsApp reports once a session is live. Writing an operator's typed,
    // unverified input into it would make every other screen show a claim nothing has confirmed.
    const row = await account({ pairingMethod: "PHONE_CODE", pairingPhoneNumber: "8801711111111" });
    expect(row.phoneNumber).toBeNull();
  });
});
