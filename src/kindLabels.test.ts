import { describe, expect, it } from "vitest";

import type { GlobalSearchHit } from "./api";
import { KIND_LABEL } from "./kindLabels";

describe("KIND_LABEL (shared between SidebarSearch and CommandPalette)", () => {
  it("has a Chinese label for every known GlobalSearchHit kind", () => {
    const kinds: GlobalSearchHit["kind"][] = [
      "file",
      "transcript",
      "description",
      "dimension",
      "ocr",
      "pinyin",
    ];
    for (const kind of kinds) {
      expect(KIND_LABEL[kind]).toBeTruthy();
    }
  });

  it("falls back to the raw kind string for an unknown/future kind", () => {
    // 后端 kind 是自由 String;未来加的取值不能在这里渲染成空徽章。
    const unknownKind = "future_kind" as GlobalSearchHit["kind"];
    expect(KIND_LABEL[unknownKind] ?? unknownKind).toBe("future_kind");
  });
});
