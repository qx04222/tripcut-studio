// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 状态条一挂载就轮询三个后端命令;jsdom 里没有 tauri 的 invoke,不打桩的话三条
// 全 reject,「缺失素材 n」那颗按钮永远不出现,测的就不是组件而是 reject 路径了。
const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMocks);

import { IMPORT_PROBE_DONE_EVENT } from "../api";
import { StatusStrip, analysisPhrase, estimateRemaining, formatRemaining, summaryPhrases } from "./StatusStrip";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";

beforeEach(() => {
  __resetWorkspaceForTests();
  apiMocks.getImportProgress.mockResolvedValue({
    total: 500, done: 12, failed: 0, running: 3, waiting_for_permit: 0, paused_for_memory: false,
  });
  apiMocks.listMissingClips.mockResolvedValue([
    { clip_id: 1, file_name: "A.MP4", volume_uuid: "v", volume_label: null, rel_path: "A.MP4", missing_since: "" },
    { clip_id: 2, file_name: "B.MP4", volume_uuid: "v", volume_label: null, rel_path: "B.MP4", missing_since: "" },
  ]);
  apiMocks.listGenerationRequests.mockResolvedValue([{ id: 1, status: "queued" } as never]);
});
afterEach(cleanup);

describe("summaryPhrases", () => {
  // R18 W-4:启动补扫挪到开窗之后,补扫期间状态条要说人话(不出现「补扫」这种内部词)。
  it("启动补扫期间排在最前,补扫结束后消失", () => {
    const idle = { analyzed: 0, analyzeTotal: 0, transcribing: 0, generating: 0, missing: 0 };
    expect(summaryPhrases({ ...idle, startupBackfill: true })).toEqual(["正在整理素材库"]);
    expect(summaryPhrases({ ...idle, startupBackfill: false })).toEqual(["后台空闲"]);
    expect(summaryPhrases({ ...idle, analyzed: 12, analyzeTotal: 500, startupBackfill: true })).toEqual([
      "正在整理素材库",
      "正在分析 12/500",
    ]);
  });

  it("按存在性依次显示中文短语", () => {
    // R12 §3:「正在分析 12/500」,估得出剩余时间时再接「,大约还要 30 秒」。
    expect(summaryPhrases({ analyzed: 12, analyzeTotal: 500, transcribing: 3, generating: 1, missing: 2 }))
      .toEqual(["正在分析 12/500", "转写 3", "云端生成 1 排队", "缺失素材 2"]);
    expect(summaryPhrases({ analyzed: 12, analyzeTotal: 500, transcribing: 0, generating: 0, missing: 0 }, "30 秒"))
      .toEqual(["正在分析 12/500,大约还要 30 秒"]);
  });
  it("为 0 的项不出现", () => {
    expect(summaryPhrases({ analyzed: 500, analyzeTotal: 500, transcribing: 0, generating: 0, missing: 2 }))
      .toEqual(["分析完成 · 500 条", "缺失素材 2"]);
  });
  it("R16 §3⑤:有活在排时按 paused_reason 说人话;user 交给「后台已暂停」不重复;后台空闲不说", () => {
    const base = { analyzed: 12, analyzeTotal: 500, transcribing: 0, generating: 0, missing: 0 };
    expect(summaryPhrases({ ...base, pausedReason: "thermal" })).toEqual(["正在分析 12/500", "电脑有点热,后台先慢下来"]);
    expect(summaryPhrases({ ...base, pausedReason: "idle_wait" })).toEqual(["正在分析 12/500", "等你不用电脑时继续"]);
    expect(summaryPhrases({ ...base, pausedReason: "memory" })).toEqual(["正在分析 12/500", "内存不足,后台先停一停"]);
    // R18 W-6:低电量模式只是减速,不是暂停。
    expect(summaryPhrases({ ...base, pausedReason: "low_power" })).toEqual(["正在分析 12/500", "电池在省电模式,后台先慢下来"]);
    expect(summaryPhrases({ ...base, pausedReason: "user" })).toEqual(["正在分析 12/500"]);
    expect(summaryPhrases({ ...base, analyzeTotal: 0, pausedReason: "thermal" })).toEqual(["后台空闲"]);
  });
  it("R15:后台还在清理缓存文件时有一句「正在清理缓存文件」", () => {
    expect(summaryPhrases({ analyzed: 0, analyzeTotal: 0, transcribing: 0, generating: 0, missing: 0, cleanup: 2 }))
      .toEqual(["正在清理缓存文件"]);
  });
  it("R15:分析已完成、预览文件还在重新生成时报「正在重新生成预览 · 还剩 n 个」;分析中不重复报", () => {
    expect(summaryPhrases({ analyzed: 5, analyzeTotal: 5, transcribing: 0, generating: 0, missing: 0, regenerating: 40 }))
      .toEqual(["分析完成 · 5 条", "正在重新生成预览 · 还剩 40 个"]);
    expect(summaryPhrases({ analyzed: 1, analyzeTotal: 5, transcribing: 0, generating: 0, missing: 0, regenerating: 40 }))
      .toEqual(["正在分析 1/5"]);
  });
  it("全空显示「后台空闲」单行", () => {
    expect(summaryPhrases({ analyzed: 0, analyzeTotal: 0, transcribing: 0, generating: 0, missing: 0 }))
      .toEqual(["后台空闲"]);
  });
});

describe("StatusStrip", () => {
  it("整条是 role=status 且 AX 名为「后台状态」", async () => {
    render(<StatusStrip />);
    expect(screen.getByRole("status", { name: "后台状态" })).toBeTruthy();
  });
  it("点整条打开导入抽屉的「任务」分页", async () => {
    __resetWorkspaceForTests();
    render(<StatusStrip />);
    (await screen.findByRole("button", { name: "查看后台任务详情" })).click();
    expect(getWorkspaceSnapshot().openDrawer).toBe("import");
    expect(getWorkspaceSnapshot().importTab).toBe("jobs");
  });
  it("点「缺失素材 n」直接落到缺失素材分页", async () => {
    __resetWorkspaceForTests();
    render(<StatusStrip />);
    (await screen.findByRole("button", { name: /缺失素材/ })).click();
    expect(getWorkspaceSnapshot().importTab).toBe("missing");
  });
  it("短语带图标:分析中 play、缺失素材 warning,库名前 check", async () => {
    apiMocks.getImportProgress.mockResolvedValue({ total: 60, done: 58, failed: 0, running: 1, waiting_for_permit: 0, paused_for_memory: false });
    apiMocks.listMissingClips.mockResolvedValue([{ clip_id: 1, file_name: "A.MP4", volume_uuid: "v", volume_label: null, rel_path: "A.MP4", missing_since: "" }]);
    render(<StatusStrip />);
    const strip = await screen.findByRole("status", { name: "后台状态" });
    await screen.findByText("正在分析 58/60");
    const analysing = screen.getByText("正在分析 58/60").closest(".workspace-status-phrase") as HTMLElement;
    expect(analysing.querySelector("svg[data-icon=\"play\"]")).not.toBeNull();
    expect(screen.getByRole("button", { name: /缺失素材 1/ }).querySelector("svg[data-icon=\"warning\"]")).not.toBeNull();
    expect(strip.querySelector(".workspace-status-library svg[data-icon=\"check\"]")).not.toBeNull();
  });
  it("分析完成后短语「分析完成 · 60 条」图标换成 check,进度条满格;3 秒后收起(R12 §3)", async () => {
    // 纯假时钟(不随真实时间走):全量并行跑时 shouldAdvanceTime 会让 3 秒收起在断言前真的过去,门禁两次假红。
    vi.useFakeTimers();
    try {
      apiMocks.getImportProgress.mockResolvedValue({ total: 60, done: 60, failed: 0, running: 0, waiting_for_permit: 0, paused_for_memory: false });
      apiMocks.listMissingClips.mockResolvedValue([]);
      render(<StatusStrip />);
      // 让首轮轮询与 mock 的 promise 在假时钟下落地。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      const done = screen.getByText("分析完成 · 60 条").closest(".workspace-status-phrase") as HTMLElement;
      expect(done.querySelector("svg[data-icon=\"check\"]")).not.toBeNull();
      expect((done.querySelector(".workspace-status-progress") as HTMLElement).style.getPropertyValue("--progress")).toBe("100%");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
      });
      expect(screen.queryByText("分析完成 · 60 条")).toBeNull();
      expect(screen.queryByText(/正在分析/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it("「查看后台任务详情」前有 info 图标,AX 名不变", async () => {
    render(<StatusStrip />);
    const main = await screen.findByRole("button", { name: "查看后台任务详情" });
    expect(main.querySelector("svg[data-icon=\"info\"]")).not.toBeNull();
  });
});

describe("R10 U-19 音乐分析计数", () => {
  it("还有排队/进行中的音乐轨时显示「音乐分析 n/m」;全部落终态后不显示", async () => {
    apiMocks.getMusicAnalysisProgress.mockResolvedValue({ total: 3, done: 1, failed: 0, running: 1, pending: 1 });
    const view = render(<StatusStrip />);
    expect(await screen.findByText("音乐分析 1/3")).toBeTruthy();
    view.unmount();
    apiMocks.getMusicAnalysisProgress.mockResolvedValue({ total: 3, done: 2, failed: 1, running: 0, pending: 0 });
    render(<StatusStrip />);
    expect(await screen.findByText("正在分析 12/500")).toBeTruthy();
    expect(screen.queryByText(/音乐分析/)).toBeNull();
  });

  it("summaryPhrases:音乐分析短语排在素材分析之后、转写之前", () => {
    expect(
      summaryPhrases({ analyzed: 1, analyzeTotal: 2, transcribing: 0, generating: 0, missing: 0, musicDone: 1, musicTotal: 3, musicActive: 2 }),
    ).toEqual(["正在分析 1/2", "音乐分析 1/3"]);
    expect(
      summaryPhrases({ analyzed: 0, analyzeTotal: 0, transcribing: 0, generating: 0, missing: 0, musicDone: 3, musicTotal: 3, musicActive: 0 }),
    ).toEqual(["后台空闲"]);
  });
});

describe("R15-perf 预览小文件进度", () => {
  it("summaryPhrases:还有预览小文件在排队 / 生成时报「正在生成预览小文件 n/m」,排在音乐分析之后;全部生成完不占位", () => {
    expect(
      summaryPhrases({ analyzed: 2, analyzeTotal: 2, transcribing: 0, generating: 0, missing: 0, musicActive: 1, musicDone: 0, musicTotal: 1, proxyDone: 1, proxyTotal: 3, proxyActive: 2 }),
    ).toEqual(["分析完成 · 2 条", "音乐分析 0/1", "正在生成预览小文件 1/3"]);
    expect(
      summaryPhrases({ analyzed: 2, analyzeTotal: 2, transcribing: 0, generating: 0, missing: 0, proxyDone: 3, proxyTotal: 3, proxyActive: 0 }),
    ).toEqual(["分析完成 · 2 条"]);
  });
  it("状态条:后端报 proxy_total / proxy_pending 时显示预览小文件进度,且「分析完成」不等它", async () => {
    apiMocks.getImportProgress.mockResolvedValue({
      total: 2, done: 2, failed: 0, running: 0, waiting_for_permit: 0, paused_for_memory: false,
      analysis_total: 2, analysis_done: 2, proxy_total: 2, proxy_pending: 1,
    });
    render(<StatusStrip />);
    const strip = await screen.findByRole("status", { name: "后台状态" });
    await screen.findByText("正在生成预览小文件 1/2");
    expect(strip.textContent).toContain("分析完成 · 2 条");
  });
});

describe("R12 §3 剩余时间估算(按最近 10 秒的速率)", () => {
  it("estimateRemaining:窗口内 10 秒做了 4 条、还剩 12 条 → 30 秒;没进展 / 样本不够 → null;窗口外的旧样本不算", () => {
    const t = 100_000;
    const samples = [
      { at: t - 30_000, done: 0 }, // 早于 10 秒窗口,不参与速率
      { at: t - 10_000, done: 8 },
      { at: t - 5_000, done: 10 },
      { at: t, done: 12 },
    ];
    expect(estimateRemaining(samples, 24, t)).toBe(30_000);
    expect(estimateRemaining([{ at: t - 10_000, done: 12 }, { at: t, done: 12 }], 24, t)).toBeNull();
    expect(estimateRemaining([{ at: t, done: 12 }], 24, t)).toBeNull();
    expect(estimateRemaining([{ at: t - 500, done: 11 }, { at: t, done: 12 }], 24, t)).toBeNull();
  });

  it("formatRemaining:< 60 秒按 5 秒向上取整说「n 秒」,≥ 60 秒说「n 分钟」", () => {
    expect(formatRemaining(30_000)).toBe("30 秒");
    expect(formatRemaining(31_000)).toBe("35 秒");
    expect(formatRemaining(2_000)).toBe("5 秒");
    expect(formatRemaining(90_000)).toBe("2 分钟");
    expect(formatRemaining(60_000)).toBe("1 分钟");
  });

  it("analysisPhrase:估不出来时只说进度;完成说「分析完成 · n 条」", () => {
    expect(analysisPhrase(12, 21, null)).toBe("正在分析 12/21");
    expect(analysisPhrase(12, 21, "30 秒")).toBe("正在分析 12/21,大约还要 30 秒");
    expect(analysisPhrase(21, 21, "30 秒")).toBe("分析完成 · 21 条");
  });

  it("状态条:两次轮询之间有进展就带上「大约还要」", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      apiMocks.getImportProgress.mockResolvedValue({ total: 24, done: 8, failed: 0, running: 3, waiting_for_permit: 0, paused_for_memory: false });
      render(<StatusStrip />);
      await screen.findByText("正在分析 8/24");
      apiMocks.getImportProgress.mockResolvedValue({ total: 24, done: 10, failed: 0, running: 3, waiting_for_permit: 0, paused_for_memory: false });
      await act(async () => {
        vi.advanceTimersByTime(3_100);
      });
      // 3 秒做了 2 条 → 还剩 14 条 ≈ 21 秒 → 向上到 25 秒。
      await screen.findByText(/^正在分析 10\/24,大约还要 \d+ 秒$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("X-04:每条素材分析完(tripcut:import-probe-done)立刻刷新计数,不等 3 秒轮询;够两个样本就带「大约还要」", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      apiMocks.getImportProgress.mockResolvedValue({ total: 166, done: 130, failed: 0, running: 3, waiting_for_permit: 0, paused_for_memory: false });
      render(<StatusStrip />);
      await screen.findByText("正在分析 130/166");
      expect(apiMocks.bridgeImportProbeEvents).toHaveBeenCalled();
      const polls = apiMocks.getImportProgress.mock.calls.length;
      apiMocks.getImportProgress.mockResolvedValue({ total: 166, done: 131, failed: 0, running: 3, waiting_for_permit: 0, paused_for_memory: false });
      await act(async () => {
        window.dispatchEvent(new CustomEvent(IMPORT_PROBE_DONE_EVENT, { detail: { job_id: 7, status: "done" } }));
        vi.advanceTimersByTime(200);
      });
      await screen.findByText("正在分析 131/166");
      expect(apiMocks.getImportProgress.mock.calls.length).toBe(polls + 1);
      // 2.5 秒后又完成一条:两个样本跨度够了 → 「大约还要」出现。
      await act(async () => {
        vi.advanceTimersByTime(2_500);
      });
      apiMocks.getImportProgress.mockResolvedValue({ total: 166, done: 132, failed: 0, running: 3, waiting_for_permit: 0, paused_for_memory: false });
      await act(async () => {
        window.dispatchEvent(new CustomEvent(IMPORT_PROBE_DONE_EVENT, { detail: { job_id: 8, status: "done" } }));
        vi.advanceTimersByTime(200);
      });
      await screen.findByText(/^正在分析 132\/166,大约还要 \d+ 秒$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("X-04:一口气完成多条时事件合并成一次刷新(100 ms 内多条只打一次后端)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      apiMocks.getImportProgress.mockResolvedValue({ total: 24, done: 8, failed: 0, running: 3, waiting_for_permit: 0, paused_for_memory: false });
      render(<StatusStrip />);
      await screen.findByText("正在分析 8/24");
      const polls = apiMocks.getImportProgress.mock.calls.length;
      await act(async () => {
        for (let i = 0; i < 5; i += 1) window.dispatchEvent(new CustomEvent(IMPORT_PROBE_DONE_EVENT, { detail: { job_id: i, status: "done" } }));
        vi.advanceTimersByTime(200);
      });
      expect(apiMocks.getImportProgress.mock.calls.length).toBe(polls + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
