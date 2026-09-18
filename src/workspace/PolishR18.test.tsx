// @vitest-environment jsdom
// R18 车道 layout(V3)。业主原则「每个界面只有一个显眼的主动作」在顶栏上一直是口头的,
// 这里把它钉成断言:更新就绪时顶栏出现过两颗实心主按钮(V-08,33-update-settings.png)。
// 第二条钉 V-07:窄屏下流水线条不许退化成四个没有文字的裸圈。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import postcss from "postcss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMocks);

import { TopBar } from "./TopBar";
import { PipelineRail } from "./PipelineRail";
import { __resetWorkspaceForTests } from "./WorkspaceStore";
import { __resetUpdateStoreForTests, runUpdateCheck, runUpdateDownload } from "./update/updateStore";
import { PIPELINE_STEP_NAMES, type PipelineState } from "./pipelineModel";

/** jsdom 没有 matchMedia;逐条用例自己装一个,查询串按 `matches` 直接回答。 */
function stubMatchMedia(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetWorkspaceForTests();
  __resetUpdateStoreForTests();
  apiMocks.setSetting.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "matchMedia");
});

describe("V-08 顶栏同一时刻只许一颗实心主按钮", () => {
  it("平时:顶栏恰好一颗 primary(「流水线下一步」)", () => {
    const { container } = render(<TopBar />);
    expect(container.querySelectorAll(".ui-button--primary").length).toBe(1);
  });

  it("更新已下载(顶栏多一颗更新胶囊)时仍然恰好一颗 primary —— 更新降为 ghost", async () => {
    apiMocks.checkForUpdate.mockResolvedValue({
      available: true,
      version: "0.8.2",
      notes: "",
      pub_date: "",
      current_version: "0.8.1",
      offline: false,
      skipped: false,
    });
    apiMocks.downloadUpdate.mockResolvedValue(undefined);
    const { container } = render(<TopBar />);
    await act(async () => {
      await runUpdateCheck("manual");
    });
    await act(async () => {
      await runUpdateDownload();
    });
    // 更新胶囊确实在场(不是因为没渲染才只有一颗)。
    expect(screen.getByRole("button", { name: "重启完成更新" })).toBeTruthy();
    expect(container.querySelectorAll(".ui-button--primary").length).toBe(1);
    expect(container.querySelector(".pipeline-next")?.className).toContain("ui-button--primary");
  });

  it("更新就绪时齿轮带一个小圆点(降级后仍然看得见有更新)", async () => {
    apiMocks.checkForUpdate.mockResolvedValue({
      available: true,
      version: "0.8.2",
      notes: "",
      pub_date: "",
      current_version: "0.8.1",
      offline: false,
      skipped: false,
    });
    apiMocks.downloadUpdate.mockResolvedValue(undefined);
    const { container } = render(<TopBar />);
    expect(container.querySelector(".workspace-topbar-right[data-update-dot]")).toBeNull();
    await act(async () => {
      await runUpdateCheck("manual");
    });
    await act(async () => {
      await runUpdateDownload();
    });
    expect(container.querySelector('.workspace-topbar-right[data-update-dot="true"]')).not.toBeNull();
  });
});

const STATE: PipelineState = {
  step: 4,
  done: [true, true, true, false],
  complete: false,
  counts: { clips: 21, analysisPending: 0, segments: 4, chaptersFilled: 2, chaptersTotal: 2, exports: 0, openChapters: 0 },
};

describe("V-07 窄屏流水线条折叠成一颗带文字的胶囊", () => {
  it("≥1440:四步都在,名字一字不差", () => {
    stubMatchMedia(true);
    render(<PipelineRail state={STATE} />);
    for (const step of [1, 2, 3, 4] as const) {
      expect(screen.getByRole("button", { name: `第 ${step} 步 ${PIPELINE_STEP_NAMES[step]}` })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: "流水线当前步" })).toBeNull();
  });

  it("<1440:只剩一颗胶囊,上面有「第 4 步 · 导出」的文字(不是裸圈);点开菜单里四步齐全", () => {
    stubMatchMedia(false);
    render(<PipelineRail state={STATE} />);
    const trigger = screen.getByRole("button", { name: "流水线当前步" });
    expect(trigger.textContent).toContain("导出");
    // 任务书写死的文案形状:「第 ④ 步 · 导出 ⌄」——带圈数字是视觉,AX 名另有一份。
    expect(trigger.textContent).toContain("第 ④ 步");
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => {
      trigger.click();
    });
    const menu = screen.getByRole("menu", { name: "流水线" });
    for (const step of [1, 2, 3, 4] as const) {
      expect(within(menu).getByRole("menuitem", { name: `第 ${step} 步 ${PIPELINE_STEP_NAMES[step]}` })).toBeTruthy();
    }
  });
});

/* ---------- 纯样式项:断言落在 polish-r18.css 的规则上 ----------
 * 版面打磨里有几条是纯 CSS(引导条、井充满栏宽、toast 移到栏底)。这些项没有 DOM 可断言,
 * 但「规则被别人覆盖掉 / 合并时丢了」是真实风险 —— 逐条解析 CSS,拿声明本身当检测器。
 * 它只证明本文件写了什么,不证明最终层叠结果,所以每条都配了前后截图(见车道报告)。
 */
const POLISH_CSS = readFileSync(resolve(process.cwd(), "src/styles/workspace/polish-r18.css"), "utf8");

function declarationsFor(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  postcss.parse(POLISH_CSS).walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls((decl) => {
      out[decl.prop] = decl.value;
    });
  });
  return out;
}

describe("polish-r18.css 的纯样式项", () => {
  it("检测器自己会响:不存在的选择器拿到空表", () => {
    expect(declarationsFor(".no-such-selector-r18")).toEqual({});
  });

  it("引导条:R19 V-02 删了顶部提示行,polish-r18 里它的样式一并清空(不留死 CSS)", () => {
    expect(declarationsFor(".workspace-shell .pipeline-hint > .ui-button")).toEqual({});
    expect(declarationsFor(".workspace-shell .pipeline-hint")).toEqual({});
  });

  it("监视器:井的舞台四边都降到 --space-3(此前左右 --space-4,各留 ~28px 死沟)", () => {
    expect(declarationsFor(".workspace-shell .monitor .monitor-stage")["padding"]).toBe("var(--space-3)");
  });

  it("toast:改到窗底(状态条上方一档),不再固定在窗顶盖住监视器栏标题条", () => {
    const host = declarationsFor(".ui-toast-host.ui-toast-host");
    expect(host["inset"]).toContain("auto 0 calc(");
    expect(host["inset"]).toContain("--workspace-status-height");
    expect(host["z-index"]).toBe("var(--z-toast)");
  });
});

describe("V-15 镜头带工具条分三组", () => {
  it("「自动挑选精选段」与「一键排入」在同一组里,且同组只有一颗实心主动作", async () => {
    const { ShotBand } = await import("./ShotBand");
    const { container } = render(<ShotBand />);
    const group = container.querySelector(".band-toolbar-actions");
    expect(group).not.toBeNull();
    const auto = screen.getByRole("button", { name: "自动挑选精选段" });
    expect(auto.closest(".band-toolbar-actions")).toBe(group);
    // 降级前它是 secondary(描边),与旁边的实心「一键排入」是同组两种样式。
    expect(auto.className).toContain("ui-button--ghost");
    expect(auto.className).not.toContain("ui-button--secondary");
    expect(group!.querySelectorAll(".ui-button--primary").length).toBeLessThanOrEqual(1);
  });

  it("五个标签页是一条 segmented control(同一个胶囊槽里分格,不是五颗独立按钮)", () => {
    const tabs = declarationsFor(".workspace-shell .shot-band .workspace-pane-chrome .band-tabs");
    expect(tabs["border-radius"]).toBe("var(--radius-pill)");
    expect(tabs["background"]).toBe("var(--surface-chrome)");
    expect(declarationsFor(".workspace-shell .shot-band .band-tabs > button.active")["box-shadow"]).toBe("var(--shadow-card)");
  });

  it("三组之间有竖分隔线与 --space-3 组间距", () => {
    expect(declarationsFor(".workspace-shell .shot-band .workspace-pane-chrome .ui-section-header-actions")["gap"]).toBe("var(--space-3)");
    expect(declarationsFor(".workspace-shell .shot-band .band-views")["border-right"]).toBe("1px solid var(--border-hair)");
    expect(declarationsFor(".workspace-shell .shot-band .band-toolbar-actions")["border-right"]).toBe("1px solid var(--border-hair)");
  });
});

describe("V-20 首页", () => {
  it("「进行中」徽标在卡片正文的标题行里,不再压在封面上", async () => {
    const { EpisodeCard } = await import("./HomeCards");
    const episode = {
      id: 1,
      title: "EP01 大理",
      episode_number: 1,
      status: "active",
      target_platform: "generic",
      clip_count: 3,
    } as unknown as Parameters<typeof EpisodeCard>[0]["episode"];
    const { container } = render(
      <EpisodeCard episode={episode} done={[true, false, false, false]} coverUrl={null} onOpen={() => undefined} />,
    );
    const state = container.querySelector(".home-episode-state");
    expect(state?.textContent).toBe("进行中");
    expect(state?.closest(".home-episode-cover")).toBeNull();
    expect(state?.closest(".home-episode-heading")).not.toBeNull();
    // 卡片的 AX 名仍以集名开头(DOM 里标题在前,视觉左置靠 order)。
    expect(container.querySelector(".home-episode-body")?.textContent?.startsWith("EP01 大理")).toBe(true);
    expect(declarationsFor(".home-screen .home-episode-body .home-episode-state")["order"]).toBe("-1");
  });

  it("三套卡片语言收敛成一套(同圆角 / 同发丝边 / 同卡片阴影)", () => {
    const unified = declarationsFor(".home-screen .home-pipeline-step");
    expect(unified["border-radius"]).toBe("var(--radius-10)");
    expect(unified["box-shadow"]).toBe("var(--shadow-card)");
    // 同一条规则同时挂着三种卡 —— 分开写就会各自漂移。
    let selectors: string[] = [];
    postcss.parse(POLISH_CSS).walkRules((rule) => {
      if (rule.selectors.includes(".home-screen .home-pipeline-step")) selectors = rule.selectors;
    });
    expect(selectors).toContain(".home-screen .home-episode-card.ui-card");
    expect(selectors).toContain(".home-screen .home-template-card.ui-card");
  });

  it("字级补上 40 → 28 → 正文的梯级;hero 下的孤立虚线换成实线发丝线", () => {
    expect(declarationsFor(".home-screen .home-title")["font-size"]).toBe("var(--text-40)");
    expect(declarationsFor(".home-screen .home-section-title")["font-size"]).toBe("var(--text-28)");
    expect(declarationsFor(".home-screen .home-hero")["border-bottom"]).toBe("1px solid var(--border-hair)");
  });
});

describe("V-27 状态条分三组 / V-22 折叠竖条", () => {
  it("状态条三组容器都在,更新与素材库各自成组;组间 --space-4", async () => {
    // V-08:真闲着时「查看后台任务详情」不占位了——给一点后台活让它出现,才能断言它落在哪组。
    apiMocks.getImportProgress.mockResolvedValue({
      total: 10, done: 3, failed: 0, running: 1, waiting_for_permit: 0, paused_for_memory: false,
    });
    const { StatusStrip } = await import("./StatusStrip");
    const { container } = render(<StatusStrip />);
    await screen.findByRole("button", { name: "查看后台任务详情" });
    for (const kind of ["tasks", "update", "library"]) {
      expect(container.querySelector(`.workspace-status-group--${kind}`), kind).not.toBeNull();
    }
    // 「查看后台任务详情」落在左组,库名落在右组 —— 分组不是摆设。
    expect(screen.getByRole("button", { name: "查看后台任务详情" }).closest(".workspace-status-group--tasks")).not.toBeNull();
    expect(container.querySelector(".workspace-status-library")?.closest(".workspace-status-group--library")).not.toBeNull();
    expect(declarationsFor(".workspace-shell .workspace-status")["gap"]).toBe("var(--space-4)");
  });

  it("折叠竖条:栏名横排(不是 vertical-rl 的竖排中文),带 tooltip,AX 名仍是「展开<栏名>」(R19:只剩媒体池会折,组件改名 PaneRail)", async () => {
    const { PaneRail } = await import("./PaneRail");
    render(<PaneRail label="媒体池" onExpand={() => undefined} />);
    const button = screen.getByRole("button", { name: "展开媒体池" });
    expect(button.getAttribute("title")).toContain("展开媒体池");
    expect(button.querySelector(".workspace-rail-label")?.textContent).toBe("媒体池");
    expect(declarationsFor(".workspace-shell .workspace-rail--r18 .workspace-rail-label")["writing-mode"]).toBe("horizontal-tb");
  });
});
