import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH, normalizeUsername, validateNewPassword, validateUsername } from "@/lib/userRules";

describe("validateUsername", () => {
  it("accepts ordinary usernames", () => {
    for (const ok of ["rudra", "md.rudra", "agent_7", "a-b", "abc"]) expect(validateUsername(ok)).toBeNull();
  });
  it("refuses the wrong length, spaces, capitals and a leading symbol", () => {
    for (const bad of ["ab", "x".repeat(41), "has space", "Upper", ".dot", "-dash", "emoji😀", "a@b"]) expect(validateUsername(bad)).not.toBeNull();
  });
  it("is applied after normalising", () => {
    expect(validateUsername(normalizeUsername("  Rudra.Hasan "))).toBeNull();
  });
});

describe("validateNewPassword", () => {
  const good = "a".repeat(MIN_PASSWORD_LENGTH);
  it("accepts a long, confirmed password", () => expect(validateNewPassword(good, good, "rudra")).toBeNull());
  it("refuses short, mismatched, or username passwords", () => {
    expect(validateNewPassword("short", "short", "rudra")).toMatch(/at least/);
    expect(validateNewPassword(good, good + "x", "rudra")).toMatch(/do not match/);
    expect(validateNewPassword("rudrarudrarudra", "rudrarudrarudra", "RudraRudraRudra")).toMatch(/username/);
  });
});
