import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("registers four real-interaction band shots in the existing single-primary harness", () => {
  const runner = readFileSync("scripts/qa/preview-shots.mjs", "utf8");
  expect(runner).toContain("await bandR22Shots(");
  const scenarios = readFileSync("src/workspace/band/previewScenarios.mjs", "utf8");
  for (const name of ["r22-band-rubber-selection", "r22-band-dragging", "r22-band-min-zoom", "r22-band-folded"]) expect(scenarios).toContain(name);
  expect(scenarios).toContain("page.mouse.down()");
  expect(scenarios).not.toContain("classList.add");
});
