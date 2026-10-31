import { describe, expect, it } from "vitest";
import { EMPTY_INBOX_FILTERS, inboxFilterKey, isDefaultInboxFilters, parseInboxFilterSet, priorityFilterOf } from "./inboxFilters.js";

describe("parseInboxFilterSet", () => {
  it("keeps valid fields and drops everything else", () => {
    const f = parseInboxFilterSet({ view: "urgent", within: "7d", search: "  router  ", tag: "Billing", teamId: "team_1", assigneeId: "u1", account: "wa:acc1", where: "1=1" });
    expect(f).toEqual({ view: "urgent", within: "7d", search: "router", tag: "billing", teamId: "team_1", assigneeId: "u1", account: "wa:acc1" });
    expect("where" in f).toBe(false);
  });

  it("refuses malformed values instead of passing them on", () => {
    const f = parseInboxFilterSet({ view: "drop table", within: "1y", tag: "a b;", teamId: "x'--", account: "sql:1", assigneeId: 5 });
    expect(f).toEqual(EMPTY_INBOX_FILTERS);
    expect(parseInboxFilterSet(null)).toEqual(EMPTY_INBOX_FILTERS);
    expect(parseInboxFilterSet({ search: "x".repeat(500) }).search).toHaveLength(120);
  });

  it("knows the default and a stable key", () => {
    expect(isDefaultInboxFilters(EMPTY_INBOX_FILTERS)).toBe(true);
    expect(isDefaultInboxFilters({ ...EMPTY_INBOX_FILTERS, tag: "vip" })).toBe(false);
    expect(inboxFilterKey({ ...EMPTY_INBOX_FILTERS, view: "mine" })).not.toBe(inboxFilterKey(EMPTY_INBOX_FILTERS));
  });

  it("maps priority views", () => {
    expect(priorityFilterOf("high")).toEqual(["HIGH", "URGENT"]);
    expect(priorityFilterOf("urgent")).toEqual(["URGENT"]);
    expect(priorityFilterOf("all")).toBeNull();
  });
});
