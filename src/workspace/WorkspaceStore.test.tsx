import { describe, expect, it } from "vitest";
import type { WorkspaceState } from "./WorkspaceStore";
import {
  INITIAL_WORKSPACE_STATE as S0,
  persistedPairs,
  workspaceReducer as reduce,
} from "./WorkspaceStore";

describe("workspaceReducer 选择模型", () => {
  it("选素材记锚点,单选清空多选", () => {
    const s = reduce(S0, { type: "select-clip", clipId: 7 });
    expect(s.selection).toEqual({ kind: "clip", clipId: 7 });
    expect(s.anchorClipId).toBe(7);
    expect(s.multiSelection).toEqual([7]);
  });
  it("选空槽位后检查器进缺口分支,多选被清空", () => {
    const s = reduce(reduce(S0, { type: "select-clip", clipId: 7 }),
      { type: "select-slot", chapterId: 3, slot: "REAL/ESTABLISHING" });
    expect(s.selection).toEqual({ kind: "slot", chapterId: 3, slot: "REAL/ESTABLISHING" });
    expect(s.multiSelection).toEqual([]);
  });
  it("⌘ 点选累加,⇧ 连选取锚点到目标的闭区间,监视器只跟最后一次点击", () => {
    let s = reduce(S0, { type: "select-clip", clipId: 2 });
    s = reduce(s, { type: "select-clip", clipId: 5, meta: true });
    expect([...s.multiSelection].sort()).toEqual([2, 5]);
    expect(s.selection).toEqual({ kind: "clip", clipId: 5 }); // 锚点项 = 最后一次点击
  });
});

describe("workspaceReducer 栏尺寸与折叠", () => {
  it("栏宽被夹在规格 §2 的上下限内", () => {
    expect(reduce(S0, { type: "set-pane-size", pane: "pool", value: 100 }).poolWidth).toBe(260);
    expect(reduce(S0, { type: "set-pane-size", pane: "pool", value: 900 }).poolWidth).toBe(480);
    expect(reduce(S0, { type: "set-pane-size", pane: "inspector", value: 100 }).inspectorWidth).toBe(280);
    expect(reduce(S0, { type: "set-pane-size", pane: "inspector", value: 900 }).inspectorWidth).toBe(520);
  });
  it("中栏上下比是 0–1 小数并被夹住", () => {
    expect(reduce(S0, { type: "set-pane-size", pane: "monitor", value: 0.02 }).monitorRatio).toBeGreaterThan(0.1);
    expect(reduce(S0, { type: "set-pane-size", pane: "monitor", value: 3 }).monitorRatio).toBeLessThanOrEqual(0.9);
  });
  it("⌘1/⌘2 只折叠两侧栏,中栏没有折叠态", () => {
    expect(reduce(S0, { type: "toggle-pane", pane: "pool" }).poolCollapsed).toBe(true);
    // R19 V-04:检查器是滑出层 —— 开着(这里 S0 已选中)⌘2 收起,记会话态。
    expect(reduce({ ...S0, selection: { kind: "clip", clipId: 1 } }, { type: "toggle-pane", pane: "inspector" }).inspectorDismissed).toBe(true);
  });
});

describe("workspaceReducer 焦点轮转(F6)", () => {
  it("按 媒体池→预览监视器→镜头带→检查器 循环", () => {
    const order = ["pool", "monitor", "band", "inspector", "pool"] as const;
    // R19 V-04:检查器只有开着(有选中 / 钉住)才在轮转里。
    let s: WorkspaceState = { ...S0, focusedPane: "pool", selection: { kind: "clip", clipId: 1 } };
    for (const expected of order.slice(1)) {
      s = reduce(s, { type: "cycle-pane-focus" });
      expect(s.focusedPane).toBe(expected);
    }
  });
  it("栏被折叠时跳过它", () => {
    const s = reduce({ ...S0, focusedPane: "band", selection: null, inspectorPinned: false },
      { type: "cycle-pane-focus" });
    expect(s.focusedPane).toBe("pool");
  });
});

describe("workspaceReducer 检查器折叠段记忆", () => {
  it("逐段开合,顺序稳定", () => {
    let s = reduce(S0, { type: "toggle-inspector-section", id: "similar" });
    s = reduce(s, { type: "toggle-inspector-section", id: "techcheck" });
    expect(s.inspectorSections).toEqual(["similar", "techcheck"]);
    s = reduce(s, { type: "toggle-inspector-section", id: "similar" });
    expect(s.inspectorSections).toEqual(["techcheck"]);
  });
});

describe("hydrate 与回写", () => {
  it("从 settings 水合;缺席的键用默认值", () => {
    const s = reduce(S0, { type: "hydrate", settings: { "ui.band.mode": "music", "ui.pane.pool_width": "400" } });
    expect(s.bandMode).toBe("music");
    expect(s.poolWidth).toBe(400);
    expect(s.inspectorWidth).toBe(340);
  });
  it("只有真的变了的键才进回写清单,焦点与抽屉永不落盘;选中只落「最近一条」(U-23)", () => {
    const a = reduce(S0, { type: "set-band-mode", mode: "journey" });
    expect(persistedPairs(S0, a)).toEqual([["ui.band.mode", "journey"]]);
    // R10 U-23:选中本身仍是会话态(多选、锚点都不落),但最近选中的素材 id 要落盘,
    // 重启后恢复。清除选中 / 选到槽位不改这个键。
    const b = reduce(a, { type: "select-clip", clipId: 9 });
    expect(persistedPairs(a, b)).toEqual([["ui.selection.last_clip", "9"]]);
    const b2 = reduce(b, { type: "clear-selection" });
    expect(persistedPairs(b, b2)).toEqual([]);
    const b3 = reduce(b2, { type: "select-slot", chapterId: 1, slot: "a" });
    expect(persistedPairs(b2, b3)).toEqual([]);
    const c = reduce(b, { type: "focus-pane", pane: "band" });
    expect(persistedPairs(b, c)).toEqual([]);
    const d = reduce(c, { type: "open-drawer", drawer: "import" });
    expect(persistedPairs(c, d)).toEqual([]); // 抽屉开合是会话态,不跟着库走
  });
  it("水合本身不产生回写(否则一启动就刷一轮设置表)", () => {
    const s = reduce(S0, { type: "hydrate", settings: { "ui.band.mode": "music" } });
    expect(persistedPairs(S0, s)).toEqual([]);
  });
});

describe("R10 U-23:启动恢复选中", () => {
  it("hydrate 把 ui.selection.last_clip 落在 restoreClipId,不直接写 selection;坏值当没有", () => {
    const s = reduce(S0, { type: "hydrate", settings: { "ui.selection.last_clip": "42" } });
    expect(s.restoreClipId).toBe(42);
    expect(s.selection).toBeNull();
    expect(reduce(S0, { type: "hydrate", settings: {} }).restoreClipId).toBeNull();
    expect(reduce(S0, { type: "hydrate", settings: { "ui.selection.last_clip": "abc" } }).restoreClipId).toBeNull();
    expect(reduce(S0, { type: "hydrate", settings: { "ui.selection.last_clip": "-3" } }).restoreClipId).toBeNull();
  });
  it("consume-restore-clip 清掉待恢复 id,且本身不回写", () => {
    const s = reduce(S0, { type: "hydrate", settings: { "ui.selection.last_clip": "42" } });
    const t = reduce(s, { type: "consume-restore-clip" });
    expect(t.restoreClipId).toBeNull();
    expect(persistedPairs(s, t)).toEqual([]);
    expect(reduce(t, { type: "consume-restore-clip" })).toBe(t);
  });
});

describe("R10 U-14:open-drawer 带设置分区", () => {
  it("open-drawer settings 记下 section;不带 section 就清空;导入抽屉不碰它", () => {
    const a = reduce(S0, { type: "open-drawer", drawer: "settings", section: "analysis" });
    expect(a.settingsSection).toBe("analysis");
    const b = reduce(a, { type: "open-drawer", drawer: "import" });
    expect(b.settingsSection).toBe("analysis");
    const c = reduce(b, { type: "open-drawer", drawer: "settings" });
    expect(c.settingsSection).toBeNull();
    expect(persistedPairs(S0, a)).toEqual([]);
  });
});
