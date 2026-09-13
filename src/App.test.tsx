// @vitest-environment jsdom
import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
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

import { documentTitleForRoute } from "./App";
import { AppShell } from "./LegacyShell";
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
    // 1280 以下就摆不开,所以窗口最小值跟着界面走,不再是旧壳的窄屏 720。
    expect(tauriConfig.app.windows[0].minWidth).toBe(1280);
    expect(tauriConfig.app.windows[0].minHeight).toBe(800);
  });

  it("renders the four workflow routes and active review view", () => {
    const markup = renderToStaticMarkup(<AppShell route="/review" />);

    expect(markup).toContain("导入");
    expect(markup).toContain("筛片");
    expect(markup).toContain("交付");
    expect(markup).toContain("设置");
    expect(markup).toContain("正在整理你的胶片墙");
    expect(markup).toContain('aria-current="page"');
  });

  it("provides a distinct window title for every view", () => {
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

  it("does not expose an actionable delivery shortcut before delivery items load", () => {
    const markup = renderToStaticMarkup(<AppShell route="/deliver" />);
    expect(markup).toContain("请先收藏整条素材或保存精选片段");
    expect(markup).toContain("disabled=\"\"");
  });
});


/** 点设置页外观分区里那一行界面开关(名字随当前壳变,所以按两种文案找)。 */
async function clickShellToggle(label: "切回旧界面" | "切换到新界面"): Promise<void> {
  const button = await screen.findByRole("button", { name: label });
  // settingsLoaded 落地前 settings-grid 是 inert 的,按钮可见但点不动 —— 多 flush
  // 几拍 Promise.allSettled 的 .then,等它落地再点。
  await act(async () => {
    for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
  });
  button.click();
  await act(async () => {
    for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
  });
}

describe("ui.workspace_v2 旗分流", () => {
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

  it("ui.workspace_v2=false 渲染旧四页壳", async () => {
    vi.mocked(getSettings).mockResolvedValue({ "ui.workspace_v2": "false" });
    const { default: App } = await import("./App");
    render(<App />);
    expect(await screen.findByRole("link", { name: /01.*导入.*INGEST/ })).toBeTruthy();
  });

  it("ui.workspace_v2=true 渲染新壳,四步导航不再出现", async () => {
    vi.mocked(getSettings).mockResolvedValue({ "ui.workspace_v2": "true" });
    const { default: App } = await import("./App");
    render(<App />);
    expect(await screen.findByRole("region", { name: "媒体池" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /INGEST/ })).toBeNull();
  });

  it("ui.workspace_v2 缺席时默认走新壳(Task 6d 把前端默认值翻成 true)", async () => {
    vi.mocked(getSettings).mockResolvedValue({});
    const { default: App } = await import("./App");
    render(<App />);
    expect(await screen.findByRole("region", { name: "媒体池" })).toBeTruthy();
  });

  it("新壳下 #/deliver 打开交付抽屉而不是换页", async () => {
    window.location.hash = "#/deliver";
    vi.mocked(getSettings).mockResolvedValue({ "ui.workspace_v2": "true" });
    const { default: App } = await import("./App");
    render(<App />);
    expect(await screen.findByRole("dialog", { name: "生成交付包" })).toBeTruthy();
    const { getWorkspaceSnapshot } = await import("./workspace/WorkspaceStore");
    expect(getWorkspaceSnapshot().openDrawer).toBe("deliver");
  });

  it("旧壳有常驻「全量搜索」侧栏,新壳没有(负断言先有正断言兜底)", async () => {
    // R8 终审 L10:原来这条只断言「新壳里查不到」——`全量搜索` 这个 AX 名就算
    // 从代码里整个消失,它也照样绿。先证明旧壳里它确实在,负断言才有意义。
    vi.mocked(getSettings).mockResolvedValue({ "ui.workspace_v2": "false" });
    const { default: App } = await import("./App");
    const legacy = render(<App />);
    await screen.findByRole("link", { name: /INGEST/ });
    expect(screen.getByLabelText("全量搜索")).toBeTruthy();
    legacy.unmount();

    __resetWorkspaceForTests();
    vi.mocked(getSettings).mockResolvedValue({ "ui.workspace_v2": "true" });
    render(<App />);
    await screen.findByRole("region", { name: "媒体池" });
    expect(screen.queryByLabelText("全量搜索")).toBeNull();
  });

  it("设置 → 外观 → 「切回旧界面」写 false 并当场换壳,不要求重启", async () => {
    vi.mocked(getSettings).mockResolvedValue({ "ui.workspace_v2": "true" });
    const { setSetting } = await import("./api");
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByRole("region", { name: "媒体池" });

    const settingsButton = screen.getByRole("button", { name: "设置" });
    settingsButton.click();
    await screen.findByRole("dialog", { name: "设置" });

    const flipBack = await screen.findByRole("button", { name: "切回旧界面" });
    // 「切回旧界面」的按钮在 settingsLoaded 落地前是可见但 inert 的
    // (SettingsPage 的 settings-grid 用 inert 挡交互)——多 flush 几拍
    // Promise.allSettled 的 .then,等它落地再点。
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    flipBack.click();
    await act(async () => {
      for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    });

    expect(vi.mocked(setSetting)).toHaveBeenCalledWith("ui.workspace_v2", "false");
    expect(await screen.findByRole("link", { name: /INGEST/ })).toBeTruthy();
  });

  it("⌘K 命令集是新 IA:打开导入/交付/设置、切附属带,不再是旧的按页跳转", async () => {
    vi.mocked(getSettings).mockResolvedValue({ "ui.workspace_v2": "true" });
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByRole("region", { name: "媒体池" });

    window.dispatchEvent(new CustomEvent("tripcut:open-command-palette"));
    const items = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(items).toEqual(
      expect.arrayContaining([
        "打开导入素材",
        "打开生成交付包",
        "打开设置",
        "打开帮助",
        "切到音乐附属带",
      ]),
    );
    // R8 终审 L10:原来这里断言的是 `去交付页` 不在列表里——这条命令在任何一个
    // 版本里都没存在过,断言恒真。换成"旧壳真有过的那条在新壳里确实没了"。
    expect(items).not.toEqual(expect.arrayContaining(["02 · 筛片工作台"]));
  });

  it("旧壳的命令集是四条页面跳转,「02 · 筛片工作台」回来了,附属带命令不出现(L7)", async () => {
    vi.mocked(getSettings).mockResolvedValue({ "ui.workspace_v2": "false" });
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByRole("link", { name: /INGEST/ });

    window.dispatchEvent(new CustomEvent("tripcut:open-command-palette"));
    const items = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(items).toEqual(
      expect.arrayContaining(["01 · 导入素材", "02 · 筛片工作台", "03 · 交付", "04 · 设置"]),
    );
    // 旧壳没有附属带:命令不是"点了没反应",而是压根不摆出来。
    expect(items.filter((text) => text?.includes("附属带"))).toEqual([]);
  });

  it("旧壳命令面板点「02 · 筛片工作台」落到 #/review", async () => {
    vi.mocked(getSettings).mockResolvedValue({ "ui.workspace_v2": "false" });
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByRole("link", { name: /INGEST/ });

    window.dispatchEvent(new CustomEvent("tripcut:open-command-palette"));
    const entry = await screen.findByText("02 · 筛片工作台");
    await act(async () => {
      entry.click();
      await Promise.resolve();
    });
    expect(window.location.hash).toBe("#/review");
  // 全量并行跑时这一条要懒加载旧壳 + 命令面板,曾在负载下超过默认 1 s(1050 ms);只给它 5 s,不改全局。
  }, 5_000);

  it("⌘K 搜到的素材点进去落在媒体池并被选中(与旧壳同一条路径)", async () => {
    vi.mocked(getSettings).mockResolvedValue({ "ui.workspace_v2": "true" });
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

  it("settings 落地前谁的壳都不渲染,只有一块中性骨架(L4)", async () => {
    // 旗默认 true,但"默认"不等于"已知"。此前这一帧直接渲染新壳,旗其实是
    // false 的用户每次启动都先看见新壳闪一下——这一条就是那道闸。
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

    expect(await screen.findByRole("status", { name: "正在载入工作台" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "媒体池" })).toBeNull();
    expect(screen.queryByRole("link", { name: /INGEST/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "导入素材" })).toBeNull();

    resolveSettings?.({ "ui.workspace_v2": "true" });
    expect(await screen.findByRole("region", { name: "媒体池" })).toBeTruthy();
  });

  it("旧壳里那一行读「切换到新界面」,写 true 并当场换到新壳(M2 反向)", async () => {
    window.location.hash = "#/settings";
    vi.mocked(getSettings).mockResolvedValue({ "ui.workspace_v2": "false" });
    const { setSetting } = await import("./api");
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByRole("link", { name: /INGEST/ });

    // 旧壳里绝不该出现「切回旧界面」——那才是单向门的样子。
    expect(screen.queryByRole("button", { name: "切回旧界面" })).toBeNull();
    await clickShellToggle("切换到新界面");

    expect(vi.mocked(setSetting)).toHaveBeenCalledWith("ui.workspace_v2", "true");
    expect(await screen.findByRole("region", { name: "媒体池" })).toBeTruthy();
  });

  it("写盘失败时不换壳,设置页留下「保存失败」(M3)", async () => {
    vi.mocked(getSettings).mockResolvedValue({ "ui.workspace_v2": "true" });
    const { setSetting } = await import("./api");
    vi.mocked(setSetting).mockRejectedValue(new Error("磁盘只读"));
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByRole("region", { name: "媒体池" });

    screen.getByRole("button", { name: "设置" }).click();
    await screen.findByRole("dialog", { name: "设置" });
    await clickShellToggle("切回旧界面");

    expect(vi.mocked(setSetting)).toHaveBeenCalledWith("ui.workspace_v2", "false");
    // 设置 sheet 页脚那条状态行(`.settings-sheet-notice`,role=status;R9 Task 7 之前是
    // 旧 SettingsPage 顶部的 `.settings-notice`)。
    expect(document.querySelector(".settings-sheet-notice")?.textContent ?? "").toContain("保存失败");
    // 壳没换:新壳的媒体池还在,旧壳的四步导航一条都没出现。
    expect(screen.getByRole("region", { name: "媒体池" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /INGEST/ })).toBeNull();
    vi.mocked(setSetting).mockResolvedValue(undefined);
  });


  it("Esc 先关最上层:面板压在抽屉上时,一次 Esc 只关面板(L9)", async () => {
    vi.mocked(getSettings).mockResolvedValue({ "ui.workspace_v2": "true" });
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
