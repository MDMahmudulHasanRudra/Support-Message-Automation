import { describe, expect, it } from "vitest";
import { isChannelInAutomationScope } from "../teams/graphSync.js";

/** Pure unit test — no DB, no network. Covers the "Manage Teams & Channels" selection logic added
 * for the one-click connection UX refinement: a linked Issue always wins over the coarser
 * team/channel enable toggle, and both levels of the toggle must be on otherwise. */
describe("isChannelInAutomationScope", () => {
  it("is in scope when both the team and channel are enabled, even with no linked issue", () => {
    expect(isChannelInAutomationScope({ isEnabledForAutomation: true }, { isEnabledForAutomation: true }, false)).toBe(true);
  });

  it("is out of scope when the team is disabled and there is no linked issue", () => {
    expect(isChannelInAutomationScope({ isEnabledForAutomation: false }, { isEnabledForAutomation: true }, false)).toBe(false);
  });

  it("is out of scope when the channel itself is disabled and there is no linked issue", () => {
    expect(isChannelInAutomationScope({ isEnabledForAutomation: true }, { isEnabledForAutomation: false }, false)).toBe(false);
  });

  it("is out of scope when both the team and channel are disabled and there is no linked issue", () => {
    expect(isChannelInAutomationScope({ isEnabledForAutomation: false }, { isEnabledForAutomation: false }, false)).toBe(false);
  });

  it("a linked open Issue always wins, even when the team and channel are both disabled", () => {
    expect(isChannelInAutomationScope({ isEnabledForAutomation: false }, { isEnabledForAutomation: false }, true)).toBe(true);
  });
});
