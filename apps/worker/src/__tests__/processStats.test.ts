import { describe, expect, it } from "vitest";
import { summariseProcessStats } from "../provider/openwa/processStats.js";

describe("summariseProcessStats (OpenWA getProcessStats -> one figure)", () => {
  it("sums cpu and memory over the process tree", () => {
    expect(
      summariseProcessStats({
        "10": { cpu: 12.5, memory: 100, pid: 10 },
        "11": { cpu: 187.5, memory: 900, pid: 11 },
      }),
    ).toEqual({ cpuPercent: 200, memoryBytes: 1000, processes: 2 });
  });

  it("skips an entry that is not a usable figure instead of inventing a zero", () => {
    expect(summariseProcessStats({ a: { cpu: 50, memory: 10 }, b: null, c: { cpu: "x" }, d: { cpu: Number.NaN }, e: { cpu: 5 } })).toEqual({
      cpuPercent: 55,
      memoryBytes: 10,
      processes: 2,
    });
  });

  it("says unknown (null) for anything that is not a usable map", () => {
    for (const bad of [null, undefined, 3, "x", {}, { a: null }, { a: { memory: 1 } }]) expect(summariseProcessStats(bad)).toBeNull();
  });
});
