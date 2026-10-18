import { beforeEach, describe, expect, it, vi } from "vitest";

// Retry the read of a still-encrypted message quickly in tests; production waits minutes.
process.env.WHATSAPP_DECRYPT_RETRY_DELAYS_MS = "20,20,20";

/**
 * A message WhatsApp Web has not been able to decrypt yet ("Waiting for this message. This may
 * take a while.") arrives as type `ciphertext` with no body. It is common on a linked device in
 * one-to-one chats — after a link, or when the sender's phone changed — and it was read as an empty
 * message and DROPPED (counted as EMPTY_BODY). When WhatsApp decrypted it moments later it changed
 * the message in place, which raises no new "message" event, so nothing ever stored it: the 18 Oct
 * 2026 incident's "many personal messages missing, groups fine".
 *
 * Now the provider keeps the id and reads the message again until it can be read, then hands it to
 * the pipeline marked `deliveredLate` (so the catch-up's automation window decides whether it may be
 * answered). Pure — no database, no browser.
 */

vi.mock("@open-wa/wa-automate", () => ({
  create: vi.fn(() => new Promise(() => {})),
  ev: { on: vi.fn() },
  STATE: {},
  MessageTypes: {},
}));

const { OpenWAProvider } = await import("../provider/openwa/OpenWAProvider.js");
const { readCollectionByKind, resetCollectionByKindForTests } = await import("../health/collectionByKind.js");

const chatId = "8801700000009@c.us";
const nowSeconds = () => Math.floor(Date.now() / 1000);

function encrypted(id: string) {
  return { id, type: "ciphertext", body: undefined, timestamp: nowSeconds(), from: chatId, chatId, fromMe: false, isGroupMsg: false };
}
function readable(id: string, body = "amar line kaj korche na") {
  return { id, type: "chat", body, timestamp: nowSeconds(), from: chatId, chatId, fromMe: false, isGroupMsg: false };
}

let provider: InstanceType<typeof OpenWAProvider>;
let emit: (message: unknown) => void;
let byId: Map<string, unknown[]>;
const delivered: Array<{ whatsappMessageId: string; body: string; deliveredLate?: boolean }> = [];

beforeEach(() => {
  delivered.length = 0;
  resetCollectionByKindForTests();
  byId = new Map();
  provider = new OpenWAProvider("acct-1", "session-1", "/tmp/nowhere");
  const client = {
    onAnyMessage: (cb: (message: unknown) => void) => {
      emit = cb;
      return Promise.resolve(true);
    },
    // What WhatsApp Web answers for this id on each successive read.
    getMessageById: vi.fn(async (id: string) => {
      const answers = byId.get(id) ?? [];
      return answers.length > 1 ? answers.shift() : answers[0];
    }),
  };
  (provider as unknown as { client: unknown }).client = client;
  provider.subscribeToMessages((raw) => delivered.push(raw));
});

describe("a message WhatsApp has not decrypted yet", () => {
  it("is not dropped: it is read again and delivered once it can be read, marked late", async () => {
    byId.set("m-1", [encrypted("m-1"), readable("m-1")]);
    emit(encrypted("m-1"));

    expect(delivered).toHaveLength(0); // never handed over empty
    await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 2_000 });
    expect(delivered[0]).toMatchObject({ whatsappMessageId: "m-1", body: "amar line kaj korche na", deliveredLate: true });
    expect(readCollectionByKind()["acct-1"]?.PERSONAL).toMatchObject({ undecrypted: 1, decryptedLater: 1 });
  });

  it("is delivered once when the readable version also arrives as a normal event", async () => {
    byId.set("m-2", [encrypted("m-2")]);
    emit(encrypted("m-2"));
    emit(readable("m-2"));

    await new Promise((resolve) => setTimeout(resolve, 150)); // past every retry
    expect(delivered.map((m) => m.whatsappMessageId)).toEqual(["m-2"]);
    expect(delivered[0]!.deliveredLate).toBeUndefined();
  });

  it("gives up after its last read and counts it, rather than retrying forever", async () => {
    byId.set("m-3", [encrypted("m-3")]);
    emit(encrypted("m-3"));

    await vi.waitFor(() => expect(readCollectionByKind()["acct-1"]?.PERSONAL?.undecryptedGaveUp).toBe(1), { timeout: 2_000 });
    expect(delivered).toHaveLength(0);
  });

  it("an ordinary readable message is delivered at once, exactly as before", () => {
    emit(readable("m-4"));
    expect(delivered.map((m) => m.whatsappMessageId)).toEqual(["m-4"]);
    expect(delivered[0]!.deliveredLate).toBeUndefined();
  });
});
