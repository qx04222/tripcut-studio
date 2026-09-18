// @vitest-environment jsdom
// R10 U-23 → R12 §1:新壳没有工具链弹窗,必需组件缺失只出横幅。api / tauri 桩与 App.test.tsx 同一套(那份已过 400 行,分出来)。
import { act } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// App() 先读 getDoctorReport 才肯渲染工作台,再读 getSettings 判旗。jsdom 里没有
// tauri 的 invoke,这两条必须打桩,否则测的是 RecoveryPage 而不是旗分流。
// 这几个 tauri 模块在 jsdom 里没有宿主,它们在 effect 里一抛,React 会把整棵树
// 拆掉,容器变成空的 —— 于是任何断言都只会报「找不到元素」,看不出真正的原因。
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    onCloseRequested: async () => () => {},
    listen: async () => () => {},
    setSize: async () => {},
    innerSize: async () => ({ width: 1512, height: 945 }),
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
// 旧壳的页面里有一串 `setX(await listX().catch(() => []))`:`.catch` 挡不住
// 「resolve 成 undefined」,渲染时 .length / .some 就抛,React 把整棵树拆掉。
// 这里让未打桩的 invoke 一律回空数组,列表形状的调用就都安全了。
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async () => undefined,
  convertFileSrc: (path: string) => path,
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  getDoctorReport: vi.fn(),
  getSettings: vi.fn(),
  // 状态条一挂载就轮询这三条;不打桩就会拿到 undefined 并在 setState 里抛。
  getImportProgress: vi.fn(async () => ({
    total: 0, done: 0, failed: 0, running: 0, waiting_for_permit: 0, paused_for_memory: false,
  })),
  listMissingClips: vi.fn(async () => []),
  listGenerationRequests: vi.fn(async () => []),
  // FirstRunGuide → SetupWizard 会 setComponents(await getComponentStatuses()),
  // 而 `.catch(() => [])` 挡不住「resolve 成 undefined」,渲染时 .some() 就炸了。
  getComponentStatuses: vi.fn(async () => []),
  listWatchedFolders: vi.fn(async () => []),
  listLibraries: vi.fn(async () => ({ libraries: [], active: null })),
  listImportBatches: vi.fn(async () => []),
  listEpisodes: vi.fn(async () => []),
  setSetting: vi.fn(async () => undefined),
  setFirstRunDone: vi.fn(async () => undefined),
  listClips: vi.fn(async () => []),
  listShotStacks: vi.fn(async () => []),
  getStoryboard: vi.fn(async () => ({ chapters: [], candidates: [], items: [] })),
  getCurrentEpisode: vi.fn(async () => null),
  getClipsRevision: vi.fn(async () => 0),
  listStoryGaps: vi.fn(async () => []),
  searchEverything: vi.fn(async () => []),
  // SettingsSheet(Task 6b/6d)挂载真实 SettingsPage——补全它需要的读取,否则
  // 未打桩的调用落到真实实现上的 invoke() 之后拿到 undefined,渲染时炸掉。
  clearCacheAndRebuild: vi.fn(async () => ({ removed_database_rows: 0, reset_jobs: 0, removed_disk_bytes: 0 })),
  clearMinimaxKey: vi.fn(async () => undefined),
  generationAvailability: vi.fn(async () => ({ enabled: false, has_key: false, budget_remaining_usd: 10 })),
  generationLedgerSummary: vi.fn(async () => ({ month: "2026-09", spent_usd: 0, budget_usd: 10, entries: [] })),
  getAppInfo: vi.fn(async () => ({ version: "0.0.0", db_schema_version: 41, worker_count: 4, read_only: false })),
  getLlmStatus: vi.fn(async () => ({
    enabled: false,
    provider: "none",
    monthly_budget: 200,
    calls_this_month: 0,
    remaining_calls: 200,
    budget_exhausted: false,
    providers: [],
  })),
  getSettingsStatus: vi.fn(async () => ({
    ffmpeg: { configured_path: "", resolved_path: "ffmpeg", available: true, version: "6.0", note: null },
    ffprobe: { configured_path: "", resolved_path: "ffprobe", available: true, version: "6.0", note: null },
    whisper: {
      binary: { configured_path: "", resolved_path: "whisper-cli", available: true, version: "1.0", note: null },
      model_tier: "large-v3-turbo",
      model_path: "",
      model_available: true,
      models_directory: "",
    },
    clip_sidecar: {
      venv_path: "",
      service_path: "",
      setup_script: "",
      available: true,
      service_available: true,
      note: "",
    },
    cache: { database_bytes: 0, disk_bytes: 0 },
  })),
  hasMinimaxKey: vi.fn(async () => false),
  listDeviceClocks: vi.fn(async () => []),
  listLlmLedger: vi.fn(async () => []),
  openLogsDirectory: vi.fn(async () => undefined),
  rollbackComponent: vi.fn(async () => ({})),
  runClipSelfCheck: vi.fn(async () => ({})),
  setMinimaxKey: vi.fn(async () => undefined),
  setDeviceClockOffset: vi.fn(async () => undefined),
}));

import { getDoctorReport, getSettings, getSettingsStatus, setFirstRunDone } from "./api";
import type * as ApiModule from "./api";
import { __resetWorkspaceForTests } from "./workspace/WorkspaceStore";

const HEALTHY_REPORT = {
  status: "OK" as const,
  checks: [],
  abnormal_exit: false,
  recovered_jobs: 0,
  cache_sampled: 0,
  cache_missing: 0,
  snapshots: [],
  restart_required: false,
};

/** 让首启引导有话可说:Whisper 模型缺席是一条非阻断步骤(R11 起**不再**自动弹,见下面的迁移用例)。 */
async function withMissingWhisperModel(): Promise<void> {
  const status = await vi.mocked(getSettingsStatus).getMockImplementation()!();
  vi.mocked(getSettingsStatus).mockResolvedValue({
    ...status,
    // mockResolvedValue 会覆盖 getMockImplementation 的返回,前一个用例拿掉的 ffmpeg 要在这里放回去。
    ffmpeg: { ...status.ffmpeg, available: true },
    whisper: { ...status.whisper, model_available: false },
  });
}

/** R11 简化专项 #1:只有 ffmpeg / ffprobe 这种必需组件缺失才自动弹工具链引导。 */
async function withMissingFfmpeg(): Promise<void> {
  const status = await vi.mocked(getSettingsStatus).getMockImplementation()!();
  vi.mocked(getSettingsStatus).mockResolvedValue({
    ...status,
    ffmpeg: { ...status.ffmpeg, available: false },
  });
}

beforeEach(() => {
  __resetWorkspaceForTests();
  window.location.hash = "";
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(cleanup);

describe("R12 §1 → R19 V-02:新壳没有工具链弹窗,必需组件缺失只在状态条左端出红点 + 一句(R10 U-23 的「不叠弹窗」由此成立)", () => {
  it("健康启动 + 必需组件(ffmpeg)缺失:没有 dialog,状态条左端出现 button「视频处理组件缺失」(红点),点它开设置", async () => {
    await withMissingFfmpeg();
    vi.mocked(getDoctorReport).mockResolvedValue(HEALTHY_REPORT);
    vi.mocked(getSettings).mockResolvedValue({});
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByRole("region", { name: "媒体池" });
    // R19 接线:红点只渲染一处 —— StatusStrip 左端的一颗按钮(band V-08 形态),数据源是壳里的 ToolchainStatusProbe。
    const strip = await screen.findByRole("status", { name: "后台状态" });
    const banner = await within(strip).findByRole("button", { name: "视频处理组件缺失" });
    expect(screen.queryByRole("dialog", { name: "先把本地工具链接好" })).toBeNull();
    expect(banner.getAttribute("aria-modal")).toBeNull();
    expect(banner.querySelector(".workspace-status-dot")).not.toBeNull();
    expect(document.querySelector(".toolchain-banner")).toBeNull(); // 顶栏下不再有横幅那一行
    await act(async () => {
      banner.click();
      await Promise.resolve();
    });
    const { getWorkspaceSnapshot } = await import("./workspace/WorkspaceStore");
    expect(getWorkspaceSnapshot().openDrawer).toBe("settings");
  });

  it("R11 简化:只缺可选组件(Whisper 模型)既不弹也不出横幅", async () => {
    await withMissingWhisperModel();
    vi.mocked(getDoctorReport).mockResolvedValue(HEALTHY_REPORT);
    vi.mocked(getSettings).mockResolvedValue({});
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByRole("region", { name: "媒体池" });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog", { name: "先把本地工具链接好" })).toBeNull();
    expect(screen.queryByRole("button", { name: "视频处理组件缺失" })).toBeNull();
  });

  it("异常退出 → 恢复页 → 进入工作台:没有弹窗叠上来;红点照常(它不是模态)", async () => {
    await withMissingFfmpeg();
    vi.mocked(getDoctorReport).mockResolvedValue({ ...HEALTHY_REPORT, status: "WARN", abnormal_exit: true });
    vi.mocked(getSettings).mockResolvedValue({});
    const { default: App } = await import("./App");
    render(<App />);
    const enter = await screen.findByRole("button", { name: "进入工作台" });
    await act(async () => {
      enter.click();
      await Promise.resolve();
    });
    await screen.findByRole("region", { name: "媒体池" });
    expect(await screen.findByRole("button", { name: "视频处理组件缺失" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("红点没有「关闭提示」(缺就是缺,一颗点不占地方);first_run_done 不决定它出不出现", async () => {
    await withMissingFfmpeg();
    vi.mocked(getDoctorReport).mockResolvedValue(HEALTHY_REPORT);
    vi.mocked(getSettings).mockResolvedValue({ "onboarding.first_run_done": "true" });
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByRole("region", { name: "媒体池" });
    const banner = await screen.findByRole("button", { name: "视频处理组件缺失" });
    expect(screen.queryByRole("button", { name: "关闭提示" })).toBeNull();
    expect(banner.getAttribute("title")).toContain("安装"); // 按钮本身就是「去安装」入口,没有第二颗按钮

    expect(setFirstRunDone).not.toHaveBeenCalled();
  });
});
