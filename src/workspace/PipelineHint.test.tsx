// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({}) as Record<string, string>),
  setSetting: vi.fn(async () => undefined),
}));
vi.mock("../api", () => apiMocks);
const pipelineMock = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("./usePipeline", () => ({ usePipeline: () => pipelineMock.state }));

import { PipelineHint, hintSeenKey, hintStepToShow } from "./PipelineHint";
import { derivePipeline, type PipelineInput } from "./pipelineModel";
import { UI_SETTING_DEFAULTS } from "./uiSettings";

const base: PipelineInput = { clipCount: 0, analysisPending: 0, segmentCount: 0, chapters: [], exportCount: 0 };

beforeEach(() => {
  pipelineMock.state = derivePipeline(base);
  apiMocks.getSettings.mockReset().mockResolvedValue({});
  apiMocks.setSetting.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("每步首次进入的提示(规格 §1 第五条)", () => {
  it("四把键 pipeline.hint_seen.1–4 有前端默认值 false", () => {
    const defaults: Readonly<Record<string, string>> = UI_SETTING_DEFAULTS;
    for (const step of [1, 2, 3, 4] as const) expect(defaults[hintSeenKey(step)]).toBe("false");
  });

  it("纯判定:设置没读回来不出;看过 / 本会话关过不出;否则出当前步", () => {
    expect(hintStepToShow(2, null, new Set())).toBeNull();
    expect(hintStepToShow(2, new Set(["pipeline.hint_seen.2"]), new Set())).toBeNull();
    expect(hintStepToShow(2, new Set(), new Set([2]))).toBeNull();
    expect(hintStepToShow(2, new Set(["pipeline.hint_seen.1"]), new Set())).toBe(2);
  });

  it("第 ① 步首次进入:status「第 1 步提示」;「知道了」收起并写 pipeline.hint_seen.1=true", async () => {
    render(<PipelineHint />);
    const hint = await screen.findByRole("status", { name: "第 1 步提示" });
    expect(hint.textContent).toContain("第 ① 步");
    await act(async () => {
      screen.getByRole("button", { name: "知道了" }).click();
      await Promise.resolve();
    });
    expect(screen.queryByRole("status", { name: "第 1 步提示" })).toBeNull();
    expect(apiMocks.setSetting).toHaveBeenCalledWith("pipeline.hint_seen.1", "true");
  });

  it("看过的步不再出;当前步换到没看过的步就换句", async () => {
    apiMocks.getSettings.mockResolvedValue({ "pipeline.hint_seen.1": "true" });
    const { rerender } = render(<PipelineHint />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("status")).toBeNull();
    pipelineMock.state = derivePipeline({ ...base, clipCount: 3 });
    rerender(<PipelineHint />);
    expect(await screen.findByRole("status", { name: "第 2 步提示" })).toBeTruthy();
  });
});
