import { expect, it } from "vitest";
import { clampTrim } from "../bandTimeline";
it("rounding never exceeds a non-decimal source boundary or moves the other edge", () => {
  expect(clampTrim({ inSec: 0.513, outSec: 4.5, clipSec: 6.06 }, "out", 100)).toEqual({ inSec: 0.513, outSec: 6.06 });
  expect(clampTrim({ inSec: 0, outSec: 0.001, clipSec: 0.001 }, "out", 100).outSec).toBe(0.001);
  expect(clampTrim({ inSec: 0.513, outSec: 4.513, clipSec: 6.06 }, "in", -100)).toEqual({ inSec: 0, outSec: 4.513 });
});
