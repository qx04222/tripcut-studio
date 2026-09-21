import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
describe("R20 P2 regression contracts", () => {
  it("results layer uses the opaque theme surface in both themes", () => {
    const css = read("src/styles/workspace/results-r19.css");
    expect(css.match(/\.results-layer\s*\{([^}]+)\}/)?.[1]).toContain("background: var(--bg-solid)");
    const themes = read("src/styles.css");
    expect(themes.match(/--bg-solid:\s*#[\da-f]+/gi)?.length).toBeGreaterThanOrEqual(2);
  });
  it("first-five exports only into its isolated scratch directory and verifies files", () => {
    const script = read("scripts/qa/first-five-minutes.mjs");
    expect(script).toContain("TRIPCUT_EXPORT_DIR: exportRoot");
    expect(script).not.toContain("${process.env.HOME}/Documents");
    expect(script).not.toContain('if (windowText().includes("已导出")) landed = true');
  });
});
