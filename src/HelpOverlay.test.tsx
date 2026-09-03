import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HelpOverlay } from "./HelpOverlay";
import {
  HELP_FAQS,
  KEYBOARD_SHORTCUT_GROUPS,
  PLAYER_SHORTCUTS,
  SELECTION_SHORTCUTS,
  WORKFLOW_STEPS,
} from "./helpContent";
import { GENERATED_LICENSES } from "./licenses.generated";

describe("P5-F3 Chinese help and polish", () => {
  it("keeps the workflow in the promised five-step order", () => {
    expect(WORKFLOW_STEPS.map((step) => step.label)).toEqual([
      "导入",
      "筛片",
      "打点",
      "故事",
      "交付",
    ]);
  });

  it("builds the complete shortcut table from shared screen constants", () => {
    expect(KEYBOARD_SHORTCUT_GROUPS[0].shortcuts).toBe(SELECTION_SHORTCUTS);
    expect(KEYBOARD_SHORTCUT_GROUPS[1].shortcuts).toBe(PLAYER_SHORTCUTS);
    expect(KEYBOARD_SHORTCUT_GROUPS.flatMap((group) => group.shortcuts)).toHaveLength(18);
  });

  it("covers toolchain, Jianying compatibility and local encryption in the FAQ", () => {
    const faqText = HELP_FAQS.map((faq) => `${faq.question}${faq.answer}`).join(" ");
    expect(faqText).toContain("工具链");
    expect(faqText).toContain("剪映");
    expect(faqText).toContain("FileVault");
  });

  it("renders an accessible Chinese dialog with every generated help section", () => {
    const markup = renderToStaticMarkup(<HelpOverlay open onClose={() => undefined} />);
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("五步工作流");
    expect(markup).toContain("快捷键总表");
    expect(markup).toContain("常见问题");
  });

  it("ships a static direct-dependency license manifest for both ecosystems", () => {
    expect(GENERATED_LICENSES.some((entry) => entry.ecosystem === "Cargo")).toBe(true);
    expect(GENERATED_LICENSES.some((entry) => entry.ecosystem === "npm")).toBe(true);
    expect(GENERATED_LICENSES.every((entry) => entry.name && entry.version && entry.license)).toBe(true);
  });
});
