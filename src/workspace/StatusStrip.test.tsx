// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 状态条一挂载就轮询三个后端命令;jsdom 里没有 tauri 的 invoke,不打桩的话三条
// 全 reject,「缺失素材 n」那颗按钮永远不出现,测的就不是组件而是 reject 路径了。
const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMocks);

import { StatusStrip, summaryPhrases } from "./StatusStrip";
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
  it("按存在性依次显示中文短语", () => {
    expect(summaryPhrases({ analyzed: 12, analyzeTotal: 500, transcribing: 3, generating: 1, missing: 2 }))
      .toEqual(["分析 12/500", "转写 3", "云端生成 1 排队", "缺失素材 2"]);
  });
  it("为 0 的项不出现", () => {
    expect(summaryPhrases({ analyzed: 500, analyzeTotal: 500, transcribing: 0, generating: 0, missing: 2 }))
      .toEqual(["分析 500/500", "缺失素材 2"]);
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
    await screen.findByText("分析 58/60");
    const analysing = screen.getByText("分析 58/60").closest(".workspace-status-phrase") as HTMLElement;
    expect(analysing.querySelector("svg[data-icon=\"play\"]")).not.toBeNull();
    expect(screen.getByRole("button", { name: /缺失素材 1/ }).querySelector("svg[data-icon=\"warning\"]")).not.toBeNull();
    expect(strip.querySelector(".workspace-status-library svg[data-icon=\"check\"]")).not.toBeNull();
  });
  it("分析完成后短语图标换成 check,进度条满格", async () => {
    apiMocks.getImportProgress.mockResolvedValue({ total: 60, done: 60, failed: 0, running: 0, waiting_for_permit: 0, paused_for_memory: false });
    apiMocks.listMissingClips.mockResolvedValue([]);
    render(<StatusStrip />);
    await screen.findByText("分析 60/60");
    const done = screen.getByText("分析 60/60").closest(".workspace-status-phrase") as HTMLElement;
    expect(done.querySelector("svg[data-icon=\"check\"]")).not.toBeNull();
    expect((done.querySelector(".workspace-status-progress") as HTMLElement).style.getPropertyValue("--progress")).toBe("100%");
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
    expect(await screen.findByText("分析 12/500")).toBeTruthy();
    expect(screen.queryByText(/音乐分析/)).toBeNull();
  });

  it("summaryPhrases:音乐分析短语排在素材分析之后、转写之前", () => {
    expect(
      summaryPhrases({ analyzed: 1, analyzeTotal: 2, transcribing: 0, generating: 0, missing: 0, musicDone: 1, musicTotal: 3, musicActive: 2 }),
    ).toEqual(["分析 1/2", "音乐分析 1/3"]);
    expect(
      summaryPhrases({ analyzed: 0, analyzeTotal: 0, transcribing: 0, generating: 0, missing: 0, musicDone: 3, musicTotal: 3, musicActive: 0 }),
    ).toEqual(["后台空闲"]);
  });
});
