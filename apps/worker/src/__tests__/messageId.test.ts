import { describe, expect, it } from "vitest";
import { serializeMessageId } from "../provider/openwa/messageId.js";

/** Pure unit test. The key objects below are the shape the catch-up actually received. */

// Verbatim from the first production catch-up, where every quoted reply failed on this value.
const PRODUCTION_KEY = {
  fromMe: false,
  remote: "120363042240607779@g.us",
  id: "A59A5CB6148375BB7E7797E0F2704397",
  participant: "252140383658006@lid",
};
const PRODUCTION_SERIALISED =
  "false_120363042240607779@g.us_A59A5CB6148375BB7E7797E0F2704397_252140383658006@lid";

describe("serializeMessageId", () => {
  it("passes a string id through untouched — the live listener's shape", () => {
    expect(serializeMessageId(PRODUCTION_SERIALISED)).toBe(PRODUCTION_SERIALISED);
  });

  it("uses _serialized when the key object carries it", () => {
    expect(serializeMessageId({ ...PRODUCTION_KEY, _serialized: PRODUCTION_SERIALISED })).toBe(PRODUCTION_SERIALISED);
  });

  it("rebuilds the exact stored value from the parts when _serialized is missing", () => {
    // This is the case that broke: an object reached Prisma where a string was expected.
    expect(serializeMessageId(PRODUCTION_KEY)).toBe(PRODUCTION_SERIALISED);
  });

  it("omits the participant segment for a one-to-one message", () => {
    expect(serializeMessageId({ fromMe: true, remote: "8801841195773@c.us", id: "ABC123" })).toBe(
      "true_8801841195773@c.us_ABC123",
    );
  });

  it("accepts a remote or participant that is itself nested as { _serialized }", () => {
    const nested = {
      fromMe: false,
      remote: { _serialized: "120363042240607779@g.us" },
      id: "A59A5CB6148375BB7E7797E0F2704397",
      participant: { _serialized: "252140383658006@lid" },
    };
    expect(serializeMessageId(nested)).toBe(PRODUCTION_SERIALISED);
  });

  it("returns null for anything that is not a usable id, rather than a garbage key", () => {
    // A null here means "no quoted message tracked", which the pipeline already handles; a
    // half-built string would instead look up a message that can never exist.
    expect(serializeMessageId(undefined)).toBeNull();
    expect(serializeMessageId(null)).toBeNull();
    expect(serializeMessageId("")).toBeNull();
    expect(serializeMessageId({})).toBeNull();
    expect(serializeMessageId({ fromMe: "false", remote: "x@g.us", id: "1" })).toBeNull();
    expect(serializeMessageId({ fromMe: false, remote: "x@g.us" })).toBeNull();
    expect(serializeMessageId(42)).toBeNull();
  });
});
