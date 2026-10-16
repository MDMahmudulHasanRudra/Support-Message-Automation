import { describe, expect, it } from "vitest";
import { describeGroupSyncBasis, GROUP_SYNC_BASES, GROUP_SYNC_BASIS_LABELS, isGroupSyncBasis } from "../groupSyncBasis.js";

describe("group sync basis", () => {
  it("describes every recorded basis, and nothing else", () => {
    for (const basis of GROUP_SYNC_BASES) expect(describeGroupSyncBasis(basis)).toBe(GROUP_SYNC_BASIS_LABELS[basis]);
    expect(describeGroupSyncBasis(null)).toBeNull();
    expect(describeGroupSyncBasis(undefined)).toBeNull();
    expect(describeGroupSyncBasis("VERIFIED_COMPLETE")).toBeNull();
    expect(isGroupSyncBasis("STABLE_READS")).toBe(true);
    expect(isGroupSyncBasis("toString")).toBe(false);
  });

  it("never claims a list is verified complete", () => {
    for (const label of Object.values(GROUP_SYNC_BASIS_LABELS)) expect(label).not.toMatch(/verified|complete|100\s*%|all groups/i);
  });
});
