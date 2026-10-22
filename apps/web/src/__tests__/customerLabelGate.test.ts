import { describe, expect, it } from "vitest";
import { customerLabelFor } from "@/server/replyAttribution";

/**
 * Review fix: the Team Report drill-down (gated on support_activity.view) listed each customer's phone number.
 * A number is printed only for a viewer who may read the messages (messages.view). Synthetic ids only.
 */
describe("customerLabelFor", () => {
  const labels = new Map([
    ["8801000000001", "+8801000000001"],
    ["100000000001", "Hidden number ···0001"],
  ]);

  it("never prints a phone number without messages.view", () => {
    expect(customerLabelFor(labels, "8801000000001", false)).toBe("Customer ···0001");
    expect(customerLabelFor(labels, "8801000000001", false)).not.toContain("8801000000001");
  });

  it("prints the stored label with messages.view", () => {
    expect(customerLabelFor(labels, "8801000000001", true)).toBe("+8801000000001");
    expect(customerLabelFor(labels, "100000000001", true)).toBe("Hidden number ···0001");
  });

  it("falls back to a masked tail when no label was collected", () => {
    expect(customerLabelFor(undefined, "8801000000009", true)).toBe("Hidden number ···0009");
    expect(customerLabelFor(undefined, "8801000000009", false)).toBe("Customer ···0009");
  });
});
