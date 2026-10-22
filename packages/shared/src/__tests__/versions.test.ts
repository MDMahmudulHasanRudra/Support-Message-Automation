import { describe, expect, it } from "vitest";
import {
  COMBINED_CALCULATION_VERSION,
  GROUP_CALCULATION_VERSION,
  IDENTITY_PREVIEW_VERSION,
  PERSONAL_CALCULATION_VERSION,
} from "../unifiedReporting/index.js";

describe("calculation versions", () => {
  it("group version is pinned", () => {
    expect(GROUP_CALCULATION_VERSION).toBe("group-2026.10.19");
    expect(PERSONAL_CALCULATION_VERSION).toBe("personal-1");
    expect(COMBINED_CALCULATION_VERSION).toBe("combined-1");
  });

  it("the identity preview version is pinned", () => {
    expect(IDENTITY_PREVIEW_VERSION).toBe("identity-preview-1");
  });
});
