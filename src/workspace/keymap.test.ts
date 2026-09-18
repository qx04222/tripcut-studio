import { describe, expect, it } from "vitest";

import {
  KEYMAP_ACTIONS,
  KEYMAP_PRESETS,
  chordFromEvent,
  conflictsFor,
  findConflicts,
  formatAction,
  formatKey,
  indexKeymap,
  lookupAction,
  parseKeymapCustom,
  resolveKeymap,
  withOverride,
  KEYMAP_ACTION_BY_ID,
  KEYMAP_COMMON_ACTIONS,
  isCommonAction,
} from "./keymap";

const ev = (over: Partial<KeyboardEvent> & { key: string; code?: string }) => ({ code: "", ...over });

describe("R13 §1 keymap:预设与解析", () => {
  it("三套预设每个动作都有键;剪映是默认;默认表零冲突", () => {
    expect(KEYMAP_PRESETS.map((preset) => preset.id)).toEqual(["jianying", "premiere", "fcp"]);
    for (const preset of KEYMAP_PRESETS) {
      for (const meta of KEYMAP_ACTIONS) expect(preset.table[meta.id], `${preset.id}/${meta.id}`).toBeDefined();
      expect(findConflicts(preset.table), preset.id).toEqual([]);
    }
    expect(resolveKeymap(undefined, undefined)).toEqual(resolveKeymap("jianying", undefined));
    expect(resolveKeymap("garbage", undefined)).toEqual(resolveKeymap("jianying", undefined));
  });

  it("剪映键位:空格、I/O、← → 逐帧、⇧← → ±5 s、J/K/L、⌘Z/⇧⌘Z、⌘E、F/X、1–5、Enter、N/⇧N、Q/W 留给分割", () => {
    const table = resolveKeymap("jianying", undefined);
    expect(table["play-pause"]).toEqual(["space"]);
    expect(table["mark-in"]).toEqual(["i"]);
    expect(table["mark-out"]).toEqual(["o"]);
    expect(table["frame-back"]).toContain("arrowleft");
    expect(table["frame-forward"]).toContain("arrowright");
    expect(table["jump-back-5s"]).toEqual(["Shift+arrowleft"]);
    expect(table["jump-forward-5s"]).toEqual(["Shift+arrowright"]);
    expect([table["shuttle-back"], table["shuttle-pause"], table["shuttle-forward"]]).toEqual([["j"], ["k"], ["l"]]);
    expect(table.undo).toEqual(["Mod+z"]);
    expect(table.redo).toEqual(["Mod+Shift+z"]);
    expect(table.export).toEqual(["Mod+e"]);
    expect([table.favorite, table.reject]).toEqual([["f"], ["x"]]);
    expect([1, 2, 3, 4, 5].map((star) => table[`star-${star}` as "star-1"])).toEqual([["1"], ["2"], ["3"], ["4"], ["5"]]);
    expect(table["adopt-suggestion"]).toEqual(["enter"]);
    expect([table["next-suggestion"], table["prev-suggestion"]]).toEqual([["n"], ["Shift+n"]]);
    expect([table["split-before"], table["split-after"]]).toEqual([["q"], ["w"]]);
    expect(KEYMAP_ACTIONS.find((meta) => meta.id === "split-before")?.pending).toContain("剪映");
  });

  it("Premiere / Final Cut 只在导出与全屏上不同", () => {
    expect(resolveKeymap("premiere", undefined).export).toEqual(["Mod+m"]);
    expect(resolveKeymap("premiere", undefined).fullscreen).toEqual(["`"]);
    expect(resolveKeymap("fcp", undefined).fullscreen).toEqual(["Mod+Shift+f"]);
    expect(resolveKeymap("fcp", undefined)["mark-in"]).toEqual(["i"]);
  });

  it("custom = 底表 + 覆盖;坏 JSON / 未知动作 / 非字符串键都被丢掉而不崩", () => {
    const custom = JSON.stringify({ base: "premiere", overrides: { favorite: ["Shift+f"], bogus: ["z"], reject: [1, "x"] } });
    const table = resolveKeymap("custom", custom);
    expect(table.export).toEqual(["Mod+m"]);
    expect(table.favorite).toEqual(["Shift+f"]);
    expect(table.reject).toEqual(["x"]);
    expect(parseKeymapCustom("{not json")).toEqual({ base: "jianying", overrides: {} });
    expect(parseKeymapCustom(JSON.stringify({ base: "custom" })).base).toBe("jianying");
    // 非 custom 预设不看覆盖。
    expect(resolveKeymap("jianying", custom).favorite).toEqual(["f"]);
  });

  it("withOverride:从命名预设改一把键时记住底表;在 custom 上再改则累加", () => {
    const first = withOverride("fcp", undefined, "favorite", ["Shift+f"]);
    expect(JSON.parse(first)).toEqual({ base: "fcp", overrides: { favorite: ["Shift+f"] } });
    const second = withOverride("custom", first, "reject", ["Backspace".toLowerCase()]);
    expect(JSON.parse(second).overrides).toEqual({ favorite: ["Shift+f"], reject: ["backspace"] });
  });
});

describe("R13 §1 keymap:冲突、事件与显示", () => {
  it("同栏撞键或与全局撞键才算冲突;监视器的 L 与媒体池的 L 不算", () => {
    const table = resolveKeymap("custom", JSON.stringify({ base: "jianying", overrides: { reject: ["f"] } }));
    expect(findConflicts(table)).toEqual([{ chord: "f", actions: ["favorite", "reject"] }]);
    expect(conflictsFor(table, "favorite")).toEqual(["reject"]);
    expect(conflictsFor(table, "lock-stack")).toEqual([]);
    const global = resolveKeymap("custom", JSON.stringify({ base: "jianying", overrides: { help: ["i"] } }));
    expect(conflictsFor(global, "mark-in")).toEqual(["help"]);
  });

  it("chordFromEvent:物理键抗输入法,⌘/Ctrl 都是 Mod,? 不再记 Shift,只按修饰键为 null", () => {
    expect(chordFromEvent(ev({ key: "Process", code: "KeyF" }))).toBe("f");
    expect(chordFromEvent(ev({ key: "1", code: "Digit1", metaKey: true }))).toBe("Mod+1");
    expect(chordFromEvent(ev({ key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true }))).toBe("Mod+Shift+z");
    expect(chordFromEvent(ev({ key: "ArrowLeft", code: "ArrowLeft", altKey: true }))).toBe("Alt+arrowleft");
    expect(chordFromEvent(ev({ key: "?", code: "Slash", shiftKey: true }))).toBe("?");
    expect(chordFromEvent(ev({ key: " ", code: "Space" }))).toBe("space");
    expect(chordFromEvent(ev({ key: "Escape" }))).toBe("escape");
    expect(chordFromEvent(ev({ key: "Shift", code: "ShiftLeft", shiftKey: true }))).toBeNull();
    expect(chordFromEvent(ev({ key: "Meta", code: "MetaLeft", metaKey: true }))).toBeNull();
  });

  it("lookupAction 按栏反查:同一把 ← 在监视器是逐帧、在媒体池是上一条", () => {
    const index = indexKeymap(resolveKeymap("jianying", undefined));
    const left = ev({ key: "ArrowLeft", code: "ArrowLeft" });
    expect(lookupAction(index, "monitor", left)).toBe("frame-back");
    expect(lookupAction(index, "pool", left)).toBe("prev-clip");
    expect(lookupAction(index, "global", ev({ key: ",", code: "Comma", metaKey: true }))).toBe("settings");
    expect(lookupAction(index, "global", ev({ key: "f", code: "KeyF" }))).toBeNull();
  });

  it("formatKey 按 macOS 惯例排修饰键:⌥⇧⌘ + 键帽", () => {
    expect(formatKey("Mod+Shift+arrowleft")).toBe("⇧⌘←");
    expect(formatKey("Alt+arrowright")).toBe("⌥→");
    expect(formatKey("space")).toBe("Space");
    expect(formatKey("Mod+enter")).toBe("⌘⏎");
    expect(formatKey("f6")).toBe("F6");
    expect(formatKey("?")).toBe("?");
    expect(formatAction(resolveKeymap("jianying", undefined), "frame-back")).toBe("← / ,");
  });
});

/** R19 P-12:默认键位表收敛 —— 常用表 ≤ 15 条(剪映用户学 F 就够);全表不删,`?` 里切「全部」。 */
describe("R19 P-12:常用键位表", () => {
  it("KEYMAP_COMMON_ACTIONS ≤ 15 条、每条都是真动作、不重复;收藏 / 入出点 / 播放 / 导入 / 帮助 在内", () => {
    expect(KEYMAP_COMMON_ACTIONS.length).toBeLessThanOrEqual(15);
    expect(new Set(KEYMAP_COMMON_ACTIONS).size).toBe(KEYMAP_COMMON_ACTIONS.length);
    for (const action of KEYMAP_COMMON_ACTIONS) expect(KEYMAP_ACTION_BY_ID.has(action)).toBe(true);
    for (const action of ["favorite", "mark-in", "mark-out", "play-pause", "import", "help"] as const) expect(KEYMAP_COMMON_ACTIONS).toContain(action);
    expect(isCommonAction("lock-stack")).toBe(false);
    expect(isCommonAction("favorite")).toBe(true);
  });
});
