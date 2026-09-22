import { describe, expect, it } from "vitest";
import { quantize, tickStep, visibleRange, fromRatio, clampEdge, parseTimecode, timecode } from "./model";

describe("R22 scrubber geometry and frame time", () => {
  it("quantizes at rational fps and clamps invalid input", () => {
    expect(quantize(1.02, 30)).toBeCloseTo(31 / 30);
    expect(quantize(1.02, 24000 / 1001)).toBeCloseTo(24 * 1001 / 24000);
    expect(quantize(-1, 30)).toBe(0);
    expect(quantize(NaN, 30)).toBe(0);
  });
  it("selects 1/2/5/10/30/60 second ticks by density", () => {
    expect([1, 2, 5, 10, 30, 60].map(s => tickStep(s * 10, 720))).toEqual([1, 2, 5, 10, 30, 60]);
  });
  it("zooms with ten percent handles, clamps boundaries and maps pixels", () => {
    expect(visibleRange(100, 20, 40, true)).toEqual([18, 42]);
    expect(visibleRange(100, 0, 40, true)).toEqual([0, 44]);
    expect(visibleRange(100, 20, 40, false)).toEqual([0, 100]);
    expect(fromRatio(0.5, [18, 42])).toBe(30);
    expect(fromRatio(2, [18, 42])).toBe(42);
  });
  it("keeps handles apart by at least one frame", () => {
    expect(clampEdge("in", 50, 10, 20, 60, 25)).toBeCloseTo(19.96);
    expect(clampEdge("out", 5, 10, 20, 60, 25)).toBeCloseTo(10.04);
  });
  it("parses mm:ss.ff and ss.ff as frames, rejects malformed or impossible frames", () => {
    expect(parseTimecode("01:04.12", 25)).toBe(64.48);
    expect(parseTimecode("4.12", 25)).toBe(4.48);
    for (const value of ["", "-1", "1:60.00", "4.25", "abc", "4.123", "1:2:3"]) expect(parseTimecode(value, 25)).toBeNull();
    expect(timecode(64.48, 25)).toBe("00:01:04.12");
    expect(timecode(4.48, 25, true)).toBe("00:04.12");
  });
});
