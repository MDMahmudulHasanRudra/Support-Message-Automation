import { describe, expect, it } from "vitest";
import { deletionOrder } from "../deletionOrder.js";

describe("deletionOrder", () => {
  it("empties a child before the table it points at", () => {
    const result = deletionOrder(["Project", "Message", "WhatsAppGroup"], [
      { child: "Message", parent: "WhatsAppGroup" },
      { child: "WhatsAppGroup", parent: "Project" },
      { child: "Message", parent: "Project" },
    ]);
    expect(result).toEqual({ ok: true, order: ["Message", "WhatsAppGroup", "Project"] });
  });

  it("orders equals alphabetically, so every run is the same", () => {
    expect(deletionOrder(["C", "A", "B"], [])).toEqual({ ok: true, order: ["A", "B", "C"] });
  });

  it("ignores a table pointing at itself and keys to tables outside the set", () => {
    expect(deletionOrder(["Message", "Project"], [
      { child: "Message", parent: "Message" },
      { child: "Message", parent: "Project" },
      { child: "Elsewhere", parent: "Project" },
    ])).toEqual({ ok: true, order: ["Message", "Project"] });
  });

  it("follows a set-null key too, so a parent's delete never rewrites a child (an immutable payment)", () => {
    // Alphabetically "AUser" would go first; the key puts the payment first.
    expect(deletionOrder(["AUser", "ZPayment"], [{ child: "ZPayment", parent: "AUser", blocking: false }])).toEqual({
      ok: true,
      order: ["ZPayment", "AUser"],
    });
  });

  it("breaks a cycle only through a non-blocking key (a client and its current subscription)", () => {
    const result = deletionOrder(["Client", "ClientSubscription", "Project"], [
      { child: "Client", parent: "ClientSubscription", blocking: false },
      { child: "ClientSubscription", parent: "Client", blocking: false },
      { child: "Client", parent: "Project" },
      { child: "ClientSubscription", parent: "Project" },
    ]);
    expect(result).toEqual({ ok: true, order: ["Client", "ClientSubscription", "Project"] });
    const blockedOneWay = deletionOrder(["A", "B"], [
      { child: "A", parent: "B", blocking: false },
      { child: "B", parent: "A" },
    ]);
    expect(blockedOneWay).toEqual({ ok: true, order: ["B", "A"] });
  });

  it("refuses a cycle of blocking keys instead of guessing", () => {
    expect(deletionOrder(["A", "B", "C"], [
      { child: "A", parent: "B" },
      { child: "B", parent: "A" },
      { child: "A", parent: "C" },
    ])).toEqual({ ok: false, cycle: ["A", "B", "C"] });
  });
});
