// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({}) as Record<string, string>),
  setSetting: vi.fn(async () => undefined),
  arrangeSelectedSegments: vi.fn(async () => ({ placed: 0, chapters: 0 })),
}));
vi.mock("../api", () => apiMocks);
vi.mock("./useClipsFeed", () => ({ refreshClipsFeed: vi.fn(async () => undefined) }));
const pipelineMock = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("./usePipeline", () => ({ usePipeline: () => pipelineMock.state }));

import { BandEmpty } from "./emptyStates";
import {
  TEACHING_CHANNELS,
  __resetGuidesForTests,
  activeTeaching,
  getGuideSnapshot,
  hydrateGuides,
  reportGuideSignals,
  reportTeachingWant,
  type TeachingChannel,
} from "./guides";
import { OnboardingCard } from "./OnboardingCard";
import { derivePipeline, type PipelineInput } from "./pipelineModel";
import { Guide } from "./ui/Guide";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

const base: PipelineInput = { clipCount: 0, analysisPending: 0, segmentCount: 0, chapters: [], exportCount: 0 };

beforeEach(() => {
  __resetGuidesForTests();
  __resetWorkspaceForTests();
  pipelineMock.state = derivePipeline(base);
  apiMocks.getSettings.mockReset().mockResolvedValue({});
  apiMocks.setSetting.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

/** R19 U-02:提示条 / 气泡 / 首启卡 / 空态卡归一个仲裁器,同一帧只出一个;顺序 = 流水线顺序;「知道了」推进。 */
describe("R19 U-02:教学仲裁器(纯函数)", () => {
  it("四路信号的任意组合:至多一个拿到槽,且按流水线顺序 首启卡 → 空态卡 → 气泡;提示条永远不拿槽(由首页四步卡 + 主按钮 tooltip 承接)", () => {
    expect(TEACHING_CHANNELS).toEqual(["onboarding", "empty", "guide", "hint"]);
    const channels: TeachingChannel[] = ["onboarding", "empty", "guide", "hint"];
    for (let mask = 0; mask < 1 << channels.length; mask += 1) {
      const wants = Object.fromEntries(channels.map((channel, index) => [channel, Boolean(mask & (1 << index))])) as Record<TeachingChannel, boolean>;
      const active = activeTeaching(wants);
      const wanted = channels.filter((channel) => wants[channel] && channel !== "hint");
      expect(active).toBe(wanted[0] ?? null);
    }
  });

  it("气泡受仲裁:首启卡在场时 guide store 的 active 为 null;首启卡「知道了」后气泡才出", async () => {
    await hydrateGuides();
    reportGuideSignals({ inWorkspace: true });
    expect(getGuideSnapshot().active).toBe("nav");
    reportTeachingWant("onboarding", true);
    expect(getGuideSnapshot().active).toBeNull();
    reportTeachingWant("onboarding", false);
    expect(getGuideSnapshot().active).toBe("nav");
  });
});

describe("R19 U-02:同一帧 `[data-teach]` ≤ 1(真组件)", () => {
  it("首启卡 + 第 ② 步空态卡 + 气泡同时有信号:DOM 里只有一个 [data-teach];关掉首启卡后轮到下一个", async () => {
    await hydrateGuides();
    render(
      <>
        <OnboardingCard clipCount={0} loading={false} />
        <BandEmpty />
        <TeachingGuide />
      </>,
    );
    await screen.findByRole("group", { name: "四步上手" });
    // 空态卡与气泡都想出:空态卡想出是因为流水线在第 ② 步,气泡因为 inWorkspace。
    pipelineMock.state = derivePipeline({ ...base, clipCount: 3 });
    await act(async () => reportGuideSignals({ inWorkspace: true }));
    expect(document.querySelectorAll("[data-teach]")).toHaveLength(1);
    expect(document.querySelector("[data-teach]")?.getAttribute("data-teach")).toBe("onboarding");

    act(() => screen.getByRole("button", { name: "关闭引导" }).click());
    expect(document.querySelectorAll("[data-teach]").length).toBeLessThanOrEqual(1);
    expect(screen.queryByRole("group", { name: "四步上手" })).toBeNull();
  });
});

/** 气泡壳:仲裁器把槽给 guide 时才画(与 GuideHost 同一条判定,这里不拉 feed)。 */
function TeachingGuide() {
  const active = getGuideSnapshot().active;
  if (active === null) return null;
  return <Guide anchor="body" text="x" side="top" onDismiss={() => undefined} />;
}
