import { describe, expect, it } from "vitest";
import { EMPTY_INBOX_FILTERS, inboxFilterKey, isDefaultInboxFilters, orderInboxItems, parseInboxFilterSet } from "../inboxFilters.js";

const row = (key: string, lastMessageAt: string | null, needsReply = false, waitingSince: string | null = null) => ({ key, lastMessageAt, needsReply, waitingSince });
const keys = (l: Array<{ key: string }>) => l.map((r) => r.key);

describe("inbox sort and last-sender filters", () => {
  it("parse: accepts the known values, stores the default order as null, drops anything else", () => {
    expect(parseInboxFilterSet({ sort: "waiting", lastSender: "customer" })).toMatchObject({ sort: "waiting", lastSender: "customer" });
    expect(parseInboxFilterSet({ sort: "newest" }).sort).toBeNull();
    expect(parseInboxFilterSet({ sort: "random", lastSender: "bot" })).toMatchObject({ sort: null, lastSender: null });
  });

  it("a sort or a last-sender choice makes the list non-default and changes the query key", () => {
    expect(isDefaultInboxFilters({ ...EMPTY_INBOX_FILTERS, sort: "oldest" })).toBe(false);
    expect(isDefaultInboxFilters({ ...EMPTY_INBOX_FILTERS, lastSender: "team" })).toBe(false);
    expect(inboxFilterKey({ ...EMPTY_INBOX_FILTERS, sort: "waiting" })).not.toBe(inboxFilterKey(EMPTY_INBOX_FILTERS));
    expect(inboxFilterKey({ ...EMPTY_INBOX_FILTERS, lastSender: "customer" })).not.toBe(inboxFilterKey({ ...EMPTY_INBOX_FILTERS, lastSender: "team" }));
  });

  const items = [
    row("a", "2026-11-06T10:00:00Z"),
    row("b", "2026-11-06T09:00:00Z", true, "2026-11-06T08:00:00Z"),
    row("c", "2026-11-06T11:00:00Z", true, "2026-11-06T07:00:00Z"),
    row("d", null),
    row("e", "2026-11-06T09:30:00Z", true, null),
    row("f", "2026-11-06T10:00:00Z"),
  ];

  it("newest (default): latest activity first, ties by key, empty conversations last", () => {
    expect(keys(orderInboxItems(items, null))).toEqual(["c", "a", "f", "e", "b", "d"]);
  });

  it("oldest: earliest activity first, ties by key, empty conversations last", () => {
    expect(keys(orderInboxItems(items, "oldest"))).toEqual(["b", "e", "a", "f", "c", "d"]);
  });

  it("waiting: needs-reply first by longest wait, unknown start after known, then the rest newest first", () => {
    expect(keys(orderInboxItems(items, "waiting"))).toEqual(["c", "b", "e", "a", "f", "d"]);
  });

  it("is stable: the same rows in any input order give the same list", () => {
    for (const sort of [null, "oldest", "waiting"] as const) {
      const once = keys(orderInboxItems(items, sort));
      expect(keys(orderInboxItems([...items].reverse(), sort))).toEqual(once);
    }
  });
});
