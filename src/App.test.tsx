// @vitest-environment jsdom
import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// App() 先读 getDoctorReport 才肯渲染工作台,再读 getSettings。jsdom 里没有
// tauri 的 invoke,这两条必须打桩,否则测的是 RecoveryPage 而不是正常启动路径。
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
  getComponentStatuses: vi.fn(async () => []),
  listWatchedFolders: vi.fn(async () => []),
  listLibraries: vi.fn(async () => ({ libraries: [], active: null })),
  listImportBatches: vi.fn(async () => []),
  listEpisodes: vi.fn(async () => []),
  setSetting: vi.fn(async () => undefined),
  listClips: vi.fn(async () => []),
  listShotStacks: vi.fn(async () => []),
  getStoryboard: vi.fn(async () => ({ chapters: [], candidates: [], items: [] })),
  getCurrentEpisode: vi.fn(async () => null),
  getClipsRevision: vi.fn(async () => 0),
  listStoryGaps: vi.fn(async () => []),
  searchEverything: vi.fn(async () => []),
  // SettingsSheet 挂载真实设置表单——补全它需要的读取,否则未打桩的调用落到
  // 真实实现上的 invoke() 之后拿到 undefined,渲染时炸掉。
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

import { documentTitleForRoute } from "./App";
import { getDoctorReport, getSettings } from "./api";
import type * as ApiModule from "./api";
import { __resetWorkspaceForTests } from "./workspace/WorkspaceStore";
import tauriConfig from "../src-tauri/tauri.conf.json";

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

describe("TripCut application shell", () => {
  it("packs the window at the R8 workspace minimum of 1280x800", () => {
    // 规格 §2:三栏(池 min 260 + 中栏 min 520 + 检查器 min 280 + 分隔条)在
    // 1280 以下就摆不开,所以窗口最小值跟着界面走。
    expect(tauriConfig.app.windows[0].minWidth).toBe(1280);
    expect(tauriConfig.app.windows[0].minHeight).toBe(800);
  });

  it("provides a distinct window title for every legacy hash route", () => {
    expect([
      documentTitleForRoute("/import"),
      documentTitleForRoute("/review"),
      documentTitleForRoute("/deliver"),
      documentTitleForRoute("/settings"),
    ]).toEqual([
      "导入素材 · 旅剪",
      "筛片工作台 · 旅剪",
      "交付 · 旅剪",
      "设置与帮助 · 旅剪",
    ]);
  });
});

describe("R17:旧四页壳已删除,永远渲染新壳", () => {
  beforeEach(() => {
    __resetWorkspaceForTests();
    window.location.hash = "";
    vi.mocked(getDoctorReport).mockResolvedValue(HEALTHY_REPORT);
    // cmdk 的 Command.Item 挂载时会 scrollIntoView 把自己滚进视口,jsdom 没有这个方法。
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });
  afterEach(cleanup);

  it("正常启动渲染新壳", async () => {
    vi.mocked(getSettings).mockResolvedValue({});
    const { default: App } = await import("./App");
    render(<App />);
    expect(await screen.findByRole("region", { name: "媒体池" })).toBeTruthy();
  });

  it("库里遗留的 ui.workspace_v2=false 不再有分支效果,照样渲染新壳(R17 §3)", async () => {
    vi.mocked(getSettings).mockResolvedValue({ "ui.workspace_v2": "false" });
    const { default: App } = await import("./App");
    render(<App />);
    expect(await screen.findByRole("region", { name: "媒体池" })).toBeTruthy();
  });

  it("新壳下 #/deliver 打开交付抽屉而不是换页", async () => {
    window.location.hash = "#/deliver";
    vi.mocked(getSettings).mockResolvedValue({});
    const { default: App } = await import("./App");
    render(<App />);
    expect(await screen.findByRole("dialog", { name: "导出" })).toBeTruthy();
    const { getWorkspaceSnapshot } = await import("./workspace/WorkspaceStore");
    expect(getWorkspaceSnapshot().openDrawer).toBe("deliver");
  });

  it("⌘K 命令集是新 IA:打开导入/交付/设置、切附属带", async () => {
    vi.mocked(getSettings).mockResolvedValue({});
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByRole("region", { name: "媒体池" });

    window.dispatchEvent(new CustomEvent("tripcut:open-command-palette"));
    const items = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(items).toEqual(
      expect.arrayContaining([
        "打开导入素材",
        "打开导出",
        "打开设置",
        "打开帮助",
        "切到音乐附属带",
      ]),
    );
  });

  it("⌘K 搜到的素材点进去落在媒体池并被选中", async () => {
    vi.mocked(getSettings).mockResolvedValue({});
    const { listClips } = await import("./api");
    vi.mocked(listClips).mockResolvedValue([
      { id: 42, file_name: "clip-42.mp4" } as Awaited<ReturnType<typeof listClips>>[number],
    ]);
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByRole("region", { name: "媒体池" });

    window.dispatchEvent(new CustomEvent("tripcut:open-command-palette"));
    const hit = await screen.findByText("clip-42.mp4");
    hit.click();

    const { getWorkspaceSnapshot } = await import("./workspace/WorkspaceStore");
    expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 42 });
  });

  it("settings 落地前只有一块中性骨架(L4)", async () => {
    let resolveSettings: ((value: Record<string, string>) => void) | undefined;
    vi.mocked(getSettings).mockReturnValue(
      new Promise<Record<string, string>>((resolve) => {
        resolveSettings = resolve;
      }),
    );
    const { default: App } = await import("./App");
    render(<App />);
    await act(async () => {
      for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    });

    const skeleton = await screen.findByRole("status", { name: "正在载入工作台" });
    // X-06:骨架不是一屏纯白,要有一句「正在准备工作台…」。
    expect(skeleton.textContent).toContain("正在准备工作台");
    expect(screen.queryByRole("region", { name: "媒体池" })).toBeNull();

    resolveSettings?.({});
    expect(await screen.findByRole("region", { name: "媒体池" })).toBeTruthy();
  });

  it("Esc 先关最上层:面板压在抽屉上时,一次 Esc 只关面板(L9)", async () => {
    vi.mocked(getSettings).mockResolvedValue({});
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByRole("region", { name: "媒体池" });

    screen.getByRole("button", { name: "设置" }).click();
    await screen.findByRole("dialog", { name: "设置" });

    window.dispatchEvent(new CustomEvent("tripcut:open-command-palette"));
    const paletteInput = await screen.findByPlaceholderText(/全量搜索/);
    expect(paletteInput).toBeTruthy();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    // 面板关了,抽屉还在——两层都挂在 document 上听 Esc,不排序就会一起关掉。
    expect(screen.queryByPlaceholderText(/全量搜索/)).toBeNull();
    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull();
  });
});
