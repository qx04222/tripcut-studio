import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({}) as Record<string, string>),
  setSetting: vi.fn(async () => undefined),
}));
vi.mock("../api", () => apiMocks);

import {
  EMPTY_GUIDE_SIGNALS,
  GUIDE_IDS,
  GUIDE_ORDER,
  GUIDES,
  __resetGuidesForTests,
  dismissGuide,
  getGuideSnapshot,
  guideKey,
  hydrateGuides,
  nextGuide,
  notePlayerStatus,
  reportGuideSignals,
  resetGuides,
  snoozeGuide,
  type GuideId,
  type GuideSignals,
} from "./guides";

const inWorkspace: GuideSignals = { ...EMPTY_GUIDE_SIGNALS, inWorkspace: true };

beforeEach(() => {
  __resetGuidesForTests();
  apiMocks.getSettings.mockReset().mockResolvedValue({});
  apiMocks.setSetting.mockReset().mockResolvedValue(undefined);
});

/** 规格 §3:七个 guide、各只弹一次、同一时刻最多一个;键 `guide.<id>.viewed`。 */
describe("guides 纯函数表", () => {
  it("首批七个 guide,键名 guide.<id>.viewed,每个都有一段话与锚点", () => {
    expect(GUIDE_IDS).toEqual(["nav", "notify", "heat", "autoselect", "shot", "gap", "export", "autoplay"]);
    for (const id of GUIDE_IDS) {
      expect(guideKey(id)).toBe(`guide.${id}.viewed`);
      expect(GUIDES[id].text.length).toBeGreaterThan(8);
      expect(GUIDES[id].anchor.length).toBeGreaterThan(0);
      // 文案不出现内部术语(业主 09-13 总原则)。
      expect(GUIDES[id].text).not.toMatch(/tick|时基|VFR|remux|L1|L3|sidecar|Stack|hero/i);
    }
  });

  it("触发条件:导航条 = 首次进入工作区;设置没读回来(viewed=null)一个都不出", () => {
    expect(nextGuide(inWorkspace, null, new Set(), new Set())).toBeNull();
    expect(nextGuide(inWorkspace, new Set(), new Set(), new Set())).toBe("nav");
    expect(nextGuide(EMPTY_GUIDE_SIGNALS, new Set(), new Set(), new Set())).toBeNull();
  });

  it("触发条件表:每个 guide 对应一个信号", () => {
    const viewed = new Set<string>([guideKey("nav")]);
    const none = new Set<GuideId>();
    expect(nextGuide({ ...inWorkspace, selectedClipHasSuggestions: true }, viewed, none, none)).toBe("heat");
    expect(nextGuide({ ...inWorkspace, pipelineStep: 2 }, viewed, none, none)).toBe("autoselect");
    expect(nextGuide({ ...inWorkspace, bandHasShots: true }, viewed, none, none)).toBe("shot");
    expect(nextGuide({ ...inWorkspace, gapVisible: true }, viewed, none, none)).toBe("gap");
    expect(nextGuide({ ...inWorkspace, exportDrawerOpen: true }, viewed, none, none)).toBe("export");
    expect(nextGuide({ ...inWorkspace, playbackEnded: true }, viewed, none, none)).toBe("autoplay");
    // 导出抽屉打开时工作区被盖住,但抽屉本身是锚点 —— 不要求 inWorkspace。
    expect(nextGuide({ ...EMPTY_GUIDE_SIGNALS, exportDrawerOpen: true }, viewed, none, none)).toBe("export");
  });

  it("同一时刻最多一个:多个条件同时满足时按 GUIDE_ORDER 取第一个;看过 / 本会话关过 / 暂缓的跳过", () => {
    const all: GuideSignals = {
      inWorkspace: true,
      selectedClipHasSuggestions: true,
      pipelineStep: 2,
      bandHasShots: true,
      gapVisible: true,
      exportDrawerOpen: false,
      overlayOpen: false,
      playbackEnded: true,
      backgroundRunning: true,
    };
    expect(GUIDE_ORDER[0]).toBe("nav");
    expect(nextGuide(all, new Set(), new Set(), new Set())).toBe("nav");
    // R18 F1:notify 排在 nav 之后(后台在分析时出),其后顺序不变。
    expect(nextGuide(all, new Set([guideKey("nav")]), new Set(), new Set())).toBe("notify");
    const seenTwo = new Set([guideKey("nav"), guideKey("notify")]);
    expect(nextGuide(all, seenTwo, new Set(), new Set())).toBe("heat");
    expect(nextGuide(all, seenTwo, new Set(["heat"]), new Set())).toBe("autoselect");
    expect(nextGuide(all, seenTwo, new Set(["heat"]), new Set(["autoselect"]))).toBe("shot");
  });
});

describe("guides store", () => {
  it("hydrate 读设置里的 guide.*.viewed;「知道了」写 guide.<id>.viewed=true 且本会话不再出", async () => {
    await hydrateGuides();
    reportGuideSignals({ inWorkspace: true });
    expect(getGuideSnapshot().active).toBe("nav");
    dismissGuide("nav");
    expect(getGuideSnapshot().active).toBeNull();
    expect(apiMocks.setSetting).toHaveBeenCalledWith("guide.nav.viewed", "true");
    reportGuideSignals({ pipelineStep: 2 });
    expect(getGuideSnapshot().active).toBe("autoselect");
  });

  it("设置里已看过的不再出;读设置失败时全部当看过(宁可少一条,不能每次启动都重复出现)", async () => {
    apiMocks.getSettings.mockResolvedValueOnce({ "guide.nav.viewed": "true" });
    await hydrateGuides();
    reportGuideSignals({ inWorkspace: true });
    expect(getGuideSnapshot().active).toBeNull();
    __resetGuidesForTests();
    apiMocks.getSettings.mockRejectedValueOnce(new Error("boom"));
    await hydrateGuides();
    reportGuideSignals({ inWorkspace: true, pipelineStep: 2 });
    expect(getGuideSnapshot().active).toBeNull();
  });

  it("正在显示的气泡不会被后来的信号换掉(同一时刻最多一个)", async () => {
    await hydrateGuides();
    reportGuideSignals({ inWorkspace: true, pipelineStep: 2 });
    expect(getGuideSnapshot().active).toBe("nav");
    reportGuideSignals({ exportDrawerOpen: true });
    expect(getGuideSnapshot().active).toBe("nav");
  });

  it("锚点找不到 → snooze:让位给下一个;条件消失后可再出", async () => {
    await hydrateGuides();
    reportGuideSignals({ inWorkspace: true, pipelineStep: 2 });
    snoozeGuide("nav");
    expect(getGuideSnapshot().active).toBe("autoselect");
    dismissGuide("autoselect");
    reportGuideSignals({ inWorkspace: false });
    reportGuideSignals({ inWorkspace: true });
    expect(getGuideSnapshot().active).toBe("nav");
  });

  it("重置新手引导:七把键写回 false,已关过的本会话也能再出", async () => {
    await hydrateGuides();
    reportGuideSignals({ inWorkspace: true });
    dismissGuide("nav");
    expect(getGuideSnapshot().active).toBeNull();
    await resetGuides();
    for (const id of GUIDE_IDS) expect(apiMocks.setSetting).toHaveBeenCalledWith(guideKey(id), "false");
    expect(getGuideSnapshot().active).toBe("nav");
  });

  it("播放器状态:播到末尾一次即锁存 playbackEnded(播完后回到开头也不丢)", async () => {
    await hydrateGuides();
    reportGuideSignals({ inWorkspace: true });
    dismissGuide("nav");
    notePlayerStatus({ phase: "ready", duration: 10, pos: 3 } as never);
    expect(getGuideSnapshot().active).toBeNull();
    notePlayerStatus({ phase: "ready", duration: 10, pos: 9.99 } as never);
    expect(getGuideSnapshot().active).toBe("autoplay");
  });

  it("Y-04:镜块引导的文案跟按钮走 —— 「往前 / 往后」,不再是「上移 / 下移」", () => {
    expect(GUIDES.shot.text).toContain("往前 / 往后");
    expect(GUIDES.shot.text).not.toMatch(/上移|下移/);
  });

  it("Y-06:抽屉 / 设置开着时不出工作区里的气泡(锚点被盖住);只有锚在抽屉里的导出气泡照出;关掉抽屉后再出", async () => {
    await hydrateGuides();
    reportGuideSignals({ inWorkspace: true, playbackEnded: true });
    expect(getGuideSnapshot().active).toBe("nav");
    // 正在显示的也要让位:抽屉一开,导航条气泡不能悬在抽屉上。
    reportGuideSignals({ overlayOpen: true });
    expect(getGuideSnapshot().active).toBeNull();
    reportGuideSignals({ exportDrawerOpen: true });
    expect(getGuideSnapshot().active).toBe("export");
    dismissGuide("export");
    expect(getGuideSnapshot().active).toBeNull();
    reportGuideSignals({ overlayOpen: false, exportDrawerOpen: false });
    expect(getGuideSnapshot().active).toBe("nav");
    expect(nextGuide({ ...inWorkspace, overlayOpen: true, playbackEnded: true }, new Set(), new Set(), new Set())).toBeNull();
  });

  it("Y-05:编号按看到的顺序数(已看几只 + 1),不是固定表里的序号", async () => {
    await hydrateGuides();
    reportGuideSignals({ inWorkspace: true, bandHasShots: true });
    expect(getGuideSnapshot().active).toBe("nav");
    expect(getGuideSnapshot().seen).toBe(0);
    dismissGuide("nav");
    expect(getGuideSnapshot().active).toBe("shot");
    // 固定表里 shot 是第 4 个,但用户只看过 1 只 → 这是第 2 只。
    expect(getGuideSnapshot().seen).toBe(1);
    __resetGuidesForTests();
    apiMocks.getSettings.mockResolvedValueOnce({ "guide.nav.viewed": "true", "guide.autoselect.viewed": "true" });
    await hydrateGuides();
    reportGuideSignals({ inWorkspace: true, playbackEnded: true });
    expect(getGuideSnapshot().active).toBe("autoplay");
    expect(getGuideSnapshot().seen).toBe(2);
  });
});
