// R14 车道 stress · Z-01 / Z-04:状态条跟素材分析同源(不再只盯登记),失败的文件算已处理。
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMocks);

import { StatusStrip, analysisPhrase, analysisProgressFrom, summaryPhrases } from "./StatusStrip";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

const base = { running: 0, waiting_for_permit: 0, paused_for_memory: false };

beforeEach(() => {
  __resetWorkspaceForTests();
  apiMocks.listMissingClips.mockResolvedValue([]);
  apiMocks.listGenerationRequests.mockResolvedValue([]);
});
afterEach(cleanup);

describe("analysisProgressFrom(Z-01)", () => {
  it("登记 213/213 全完成但画质 / 运镜还在分析 → 分子取分析进度,不是「后台空闲」", () => {
    expect(analysisProgressFrom({ ...base, total: 213, done: 213, failed: 0, analysis_total: 213, analysis_done: 124 }))
      .toEqual({ analyzed: 124, total: 213, failed: 0 });
    expect(summaryPhrases({ analyzed: 124, analyzeTotal: 213, transcribing: 0, generating: 0, missing: 0 })).toEqual(["正在分析 124/213"]);
  });
  it("旧后端没有 analysis_* 字段 → 退回登记进度(done + failed)", () => {
    expect(analysisProgressFrom({ ...base, total: 60, done: 58, failed: 0 })).toEqual({ analyzed: 58, total: 60, failed: 0 });
  });
  it("重复文件没有素材行,也算已处理:5 新 + 3 重复 → 8/8", () => {
    expect(analysisProgressFrom({ ...base, total: 8, done: 8, failed: 0, duplicate: 3, analysis_total: 5, analysis_done: 5 }))
      .toEqual({ analyzed: 8, total: 8, failed: 0 });
  });
});

describe("Z-04 失败的文件算已处理", () => {
  it("7 条分析完 + 2 条无法分析 → 「分析完成 · 7 条,2 条无法分析」,不再永远「正在分析 7/9」", () => {
    const merged = analysisProgressFrom({ ...base, total: 9, done: 7, failed: 2, analysis_total: 7, analysis_done: 7 });
    expect(merged).toEqual({ analyzed: 9, total: 9, failed: 2 });
    expect(analysisPhrase(merged.analyzed, merged.total, null, merged.failed)).toBe("分析完成 · 7 条,2 条无法分析");
    expect(summaryPhrases({ analyzed: 9, analyzeTotal: 9, analyzeFailed: 2, transcribing: 0, generating: 0, missing: 0 }))
      .toEqual(["分析完成 · 7 条,2 条无法分析"]);
    // 还在分析时失败的也已经计入分子。
    expect(analysisProgressFrom({ ...base, total: 9, done: 7, failed: 2, analysis_total: 7, analysis_done: 3 }))
      .toEqual({ analyzed: 5, total: 9, failed: 2 });
  });

  it("状态条:分析中显示分析进度;两条失败后显示「分析完成 · 7 条,2 条无法分析」而不是「后台空闲」/「正在分析 7/9」", async () => {
    apiMocks.getImportProgress.mockResolvedValue({ ...base, total: 213, done: 213, failed: 0, analysis_total: 213, analysis_done: 124 });
    const view = render(<StatusStrip />);
    expect(await screen.findByText("正在分析 124/213")).toBeTruthy();
    expect(screen.queryByText("后台空闲")).toBeNull();
    view.unmount();

    apiMocks.getImportProgress.mockResolvedValue({ ...base, total: 9, done: 7, failed: 2, analysis_total: 7, analysis_done: 7 });
    render(<StatusStrip />);
    expect(await screen.findByText("分析完成 · 7 条,2 条无法分析")).toBeTruthy();
    expect(screen.queryByText(/正在分析/)).toBeNull();
  });
});
