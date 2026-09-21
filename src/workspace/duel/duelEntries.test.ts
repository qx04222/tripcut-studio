import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("connects results, band and pool menus to the shared duel entry", () => {
  for (const path of ["results/ResultsPanel.tsx", "BandSegmentMenu.tsx", "ClipMenu.tsx"]) {
    expect(readFileSync(`src/workspace/${path}`, "utf8")).toContain("requestDuel(");
  }
});
it("mounts the host around the monitor and lists 擂台 in the command palette", () => {
  expect(readFileSync("src/workspace/WorkspaceShell.tsx", "utf8")).toContain("<DuelHost><Monitor /></DuelHost>");
  expect(readFileSync("src/CommandPalette.tsx", "utf8")).toContain("requestDuel({ workspaceMode })");
});
it("preview enters the six-photo duel from the independent photo workspace", () => {
  expect(readFileSync("scripts/qa/preview-shots.mjs", "utf8")).toContain("await duelScenario(context, vite.url, shot, failures, withTheme)");
  const scenario = readFileSync("scripts/qa/duel-scenario.mjs", "utf8");
  for (const needle of ['{ name: "照片工作台" }', "43-photo-duel", "第 1/5 场", "本组已选好", "精选带"]) expect(scenario).toContain(needle);
  expect(scenario).not.toMatch(/39-duel-arena|40-duel-finish/);
});
