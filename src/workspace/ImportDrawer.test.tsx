// @vitest-environment jsdom
import { act } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 整份 api 替身由 `./testApiMock` 从 `src/api.ts` 的真实导出表生成 —— 不再手抄
// 名单,加一条新命令不用改这里(见 testApiMock.ts 顶部)。
const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({
    getCurrentEpisode: vi.fn(async () => ({ id: 1, title: "EP01", theme: "通用" })),
    getClipsRevision: vi.fn(async () => "rev-0"),
    startImport: vi.fn(async () => ({ imported: 0, duplicates: 0, failed: 0 })),
    getClipArtifacts: vi.fn(async () => ({})),
    rescanWatchedFolders: vi.fn(async () => ({ added: 0 })),
    previewImportRemoval: vi.fn(async () => ({ clips: 0, favorites: 0, selections: 0, cache_entries: 0 })),
    relinkVolume: vi.fn(async () => ({ relinked: 0, rejected: [], still_missing: 0 })),
    pickImportFolder: vi.fn(async () => null),
    pickRelinkFolder: vi.fn(async () => null),
  });
});
vi.mock("../api", () => apiMocks);

// 拖放事件的桩把回调留下来,用例里手动喂 enter / drop(useImportSources 在消费)。
const webview = vi.hoisted(() => ({ dropHandler: null as ((event: unknown) => void) | null }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (callback: (event: unknown) => void) => {
      webview.dropHandler = callback;
      return Promise.resolve(() => {
        webview.dropHandler = null;
      });
    },
  }),
}));

import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

beforeEach(() => {
  __resetWorkspaceForTests();
  webview.dropHandler = null;
  apiMocks.listWatchedFolders.mockResolvedValue([]);
  apiMocks.listImportBatches.mockResolvedValue([]);
  apiMocks.listMissingClips.mockResolvedValue([]);
});
afterEach(cleanup);

async function openImportDrawer(): Promise<void> {
  await act(async () => {
    const button = screen.getByRole("button", { name: "导入素材" });
    // jsdom 的原生 .click() 不像真实浏览器那样先聚焦被点元素——不手动 focus()
    // 就没法验证「关闭后焦点回到触发按钮」,因为 useFocusTrap 记录的是激活前
    // 的 document.activeElement。
    button.focus();
    button.click();
    await Promise.resolve();
  });
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
  });
}

describe("导入抽屉", () => {
  it("点「导入素材」从左侧滑入,role=dialog aria-modal,标题「导入素材」", async () => {
    render(<WorkspaceShell />);
    await openImportDrawer();
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("三个分页名为 来源 / 任务 / 缺失素材", async () => {
    render(<WorkspaceShell />);
    await openImportDrawer();
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    expect(within(dialog).getAllByRole("tab").map((t) => t.textContent)).toEqual(["来源", "任务", "缺失素材"]);
  });

  it("Esc 关闭且不改 hash", async () => {
    render(<WorkspaceShell />);
    await openImportDrawer();
    await screen.findByRole("dialog", { name: "导入素材" });
    const before = window.location.hash;
    await pressEscape();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.hash).toBe(before);
  });

  it("关闭后焦点回到「导入素材」按钮", async () => {
    render(<WorkspaceShell />);
    await openImportDrawer();
    await screen.findByRole("dialog", { name: "导入素材" });
    await pressEscape();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "导入素材" }));
  });

  it("抽屉打开态下「松开即导入」不在树里(冒烟 drawer.import.dropOverlay.hidden)", async () => {
    render(<WorkspaceShell />);
    await openImportDrawer();
    await screen.findByRole("dialog", { name: "导入素材" });
    expect(screen.queryByText("松开即导入")).toBeNull();
  });

  it("宽度为 min(720, 60vw)", async () => {
    render(<WorkspaceShell />);
    await openImportDrawer();
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    expect(dialog.style.width).toBe("min(720px, 60vw)");
  });

  it("状态条的「任务」入口直接落在「任务」分页", async () => {
    render(<WorkspaceShell />);
    await act(async () => {
      (await screen.findByRole("button", { name: "查看后台任务详情" })).click();
      await Promise.resolve();
    });
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    expect(within(dialog).getByRole("tab", { name: "任务", selected: true })).toBeTruthy();
  });
});

describe("导入抽屉:原生内容(R9 Task 5)", () => {
  it("来源分页:说明 + 「添加素材文件夹」primary + 关注文件夹卡(路径/上次同步/自动同步 switch/移除),没有英文 kicker", async () => {
    apiMocks.listWatchedFolders.mockResolvedValue([
      { id: 1, path: "/Volumes/TRIP_2026", auto_sync: true, added_at: "", last_scan_at: "2026-09-11T08:00:00Z" },
    ]);
    render(<WorkspaceShell />);
    await openImportDrawer();
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    expect(within(dialog).getByRole("button", { name: "添加素材文件夹" }).className).toContain("ui-button--primary");
    expect(within(dialog).getByText("只建立索引，不复制或改写原片")).toBeTruthy();
    // R10 U-07 起路径拆成头 / 尾两段做中间省略,整条路径在 aria-label 上。
    expect(await within(dialog).findByLabelText("/Volumes/TRIP_2026")).toBeTruthy();
    expect(within(dialog).getByText("上次同步 2026-09-11 08:00")).toBeTruthy();
    expect(within(dialog).getByRole("switch", { name: "自动同步" }).getAttribute("aria-checked")).toBe("true");
    expect(within(dialog).getByRole("button", { name: "移除" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "立即扫描" })).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/SOURCE|WATCHED|INGEST/);
  });

  it("来源分页:自动同步 switch 调 setWatchedFolderSync,「移除」调 removeWatchedFolder", async () => {
    apiMocks.listWatchedFolders.mockResolvedValue([
      { id: 1, path: "/Volumes/TRIP_2026", auto_sync: true, added_at: "", last_scan_at: null },
    ]);
    render(<WorkspaceShell />);
    await openImportDrawer();
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    await within(dialog).findByLabelText("/Volumes/TRIP_2026");
    await act(async () => {
      within(dialog).getByRole("switch", { name: "自动同步" }).click();
      await Promise.resolve();
    });
    expect(apiMocks.setWatchedFolderSync).toHaveBeenCalledWith(1, false);
    await act(async () => {
      within(dialog).getByRole("button", { name: "移除" }).click();
      await Promise.resolve();
    });
    expect(apiMocks.removeWatchedFolder).toHaveBeenCalledWith(1);
  });

  it("来源分页没有关注文件夹时显示 EmptyState", async () => {
    apiMocks.listWatchedFolders.mockResolvedValue([]);
    render(<WorkspaceShell />);
    await openImportDrawer();
    expect(await screen.findByText("还没有关注的文件夹")).toBeTruthy();
  });

  it("来源分页:工具链缺失时出警告卡,「去设置」打开设置 sheet 而不改 hash", async () => {
    apiMocks.getSettingsStatus.mockResolvedValue({
      ffmpeg: { available: false }, ffprobe: { available: true },
    } as never);
    render(<WorkspaceShell />);
    await openImportDrawer();
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("应用内置的媒体工具不可用");
    const before = window.location.hash;
    await act(async () => {
      within(alert).getByRole("button", { name: "去设置" }).click();
      await Promise.resolve();
    });
    expect(window.location.hash).toBe(before);
    const settings = await screen.findByRole("dialog", { name: "设置" });
    // R10 U-14 的 openSettings(section):直接落到工具链所在的分区;R11 简化专项 #2 起它住在「工具与模型」。
    expect(within(settings).getByRole("tab", { name: "工具与模型", selected: true })).toBeTruthy();
    expect(within(settings).getByRole("heading", { level: 3, name: "工具链" })).toBeTruthy();
  });

  it("任务分页:进度卡三行阶段 + 批次卡「停止本批」/「撤销本批…」", async () => {
    apiMocks.getImportProgress.mockResolvedValue({ total: 60, done: 58, failed: 1, running: 1, waiting_for_permit: 0, paused_for_memory: false });
    apiMocks.listImportBatches.mockResolvedValue([
      { id: 7, source: "/Volumes/CARD/2026-08-12", status: "scanning", total: 12, done: 10, running: 2, failed: 0, duplicates: 0, imported: 12 },
    ]);
    __resetWorkspaceForTests({ openDrawer: "import", importTab: "jobs" });
    render(<WorkspaceShell />);
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    expect(await within(dialog).findByText("已处理 59 / 60")).toBeTruthy();
    for (const stage of ["索引", "画质分析", "运镜分析"]) expect(within(dialog).getByText(stage)).toBeTruthy();
    // R10 U-08 起三段各有自己的进度条,索引那条按名字找。
    expect(within(dialog).getByRole("progressbar", { name: "索引进度" }).getAttribute("aria-valuenow")).toBe("59");
    expect(within(dialog).getByText("2026-08-12")).toBeTruthy();
    // Badge 的文字在内层 label span 里,角标 class 挂在外层。
    expect(within(dialog).getByText("正在扫描").closest(".ui-badge")?.className).toContain("ui-badge");
    expect(within(dialog).getByRole("button", { name: "停止本批" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "撤销本批…" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /移除选中/ })).toBeNull();
    expect(dialog.textContent).not.toMatch(/SOURCE|WATCHED|INGEST|AUDIO|CONTACT SHEET/);
  });

  it("任务分页:「停止本批」调 cancelImportBatch,通知「已入库素材保留」", async () => {
    apiMocks.listImportBatches.mockResolvedValue([
      { id: 7, source: "/x", status: "scanning", total: 1, done: 0, running: 1, failed: 0, duplicates: 0, imported: 0 },
    ]);
    __resetWorkspaceForTests({ openDrawer: "import", importTab: "jobs" });
    render(<WorkspaceShell />);
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    await act(async () => {
      (await within(dialog).findByRole("button", { name: "停止本批" })).click();
      await Promise.resolve();
    });
    expect(apiMocks.cancelImportBatch).toHaveBeenCalledWith(7);
    expect((await screen.findByText(/已入库素材保留/)).textContent).toContain("已停止本批");
  });

  it("撤销本批走确认框(alertdialog「确认移除素材」,文案含「原视频不会删除」);取消不删", async () => {
    apiMocks.listImportBatches.mockResolvedValue([
      { id: 7, source: "/x", status: "completed", total: 1, done: 1, running: 0, failed: 0, duplicates: 0, imported: 1 },
    ]);
    apiMocks.previewImportRemoval.mockResolvedValue({ clips: 1, favorites: 0, selections: 0, cache_entries: 0 });
    __resetWorkspaceForTests({ openDrawer: "import", importTab: "jobs" });
    render(<WorkspaceShell />);
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    await act(async () => {
      (await within(dialog).findByRole("button", { name: "撤销本批…" })).click();
      await Promise.resolve();
    });
    const confirm = await screen.findByRole("alertdialog", { name: "确认移除素材" });
    expect(confirm.textContent).toContain("原视频不会删除");
    expect(document.activeElement).toBe(confirm);
    expect(confirm.textContent).toContain("将移除 1 条素材");
    await act(async () => {
      within(confirm).getByRole("button", { name: "取消" }).click();
      await Promise.resolve();
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(apiMocks.removeImportedMaterial).not.toHaveBeenCalled();
  });

  it("任务分页:「清空当前集素材…」与「清理重复/失败提示」在批量操作行,没有「移除选中」", async () => {
    __resetWorkspaceForTests({ openDrawer: "import", importTab: "jobs" });
    render(<WorkspaceShell />);
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    expect(await within(dialog).findByRole("button", { name: "清空当前集素材…" })).toBeTruthy();
    await act(async () => {
      within(dialog).getByRole("button", { name: "清理重复/失败提示" }).click();
      await Promise.resolve();
    });
    expect(apiMocks.dismissImportNotices).toHaveBeenCalled();
    expect(await within(dialog).findByText(/已清理重复\/失败提示/)).toBeTruthy();
  });

  it("缺失素材分页:按卷分组 + 「重新定位」调 relinkVolume,结果摘要文案不变", async () => {
    apiMocks.listMissingClips.mockResolvedValue([
      { clip_id: 1, file_name: "A.MOV", volume_uuid: "vol-1", volume_label: "SD Card", rel_path: "DCIM/A.MOV", missing_since: "" },
    ]);
    apiMocks.pickRelinkFolder.mockResolvedValue("/Volumes/New");
    apiMocks.relinkVolume.mockResolvedValue({ relinked: 1, rejected: [], still_missing: 0 });
    __resetWorkspaceForTests({ openDrawer: "import", importTab: "missing" });
    render(<WorkspaceShell />);
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    expect(await within(dialog).findByText("SD Card")).toBeTruthy();
    expect(within(dialog).getByText("A.MOV")).toBeTruthy();
    expect(within(dialog).getByText("1 个文件缺失").closest(".ui-badge")?.className).toContain("ui-badge--warn");
    await act(async () => {
      within(dialog).getByRole("button", { name: "重新定位" }).click();
      await Promise.resolve();
    });
    await waitFor(() => expect(apiMocks.relinkVolume).toHaveBeenCalledWith("vol-1", "/Volumes/New"));
    expect(await within(dialog).findByText(/已重绑 1/)).toBeTruthy();
  });

  it("没有缺失素材时显示「所有素材都在原位」", async () => {
    apiMocks.listMissingClips.mockResolvedValue([]);
    __resetWorkspaceForTests({ openDrawer: "import", importTab: "missing" });
    render(<WorkspaceShell />);
    expect(await screen.findByText("所有素材都在原位")).toBeTruthy();
  });

  it("拖入时抽屉内出现「松开即导入」覆盖层(role=status);平时不在树里;松手调 importPaths", async () => {
    apiMocks.importPaths.mockResolvedValue([{ folder: "/a", total: 1, enqueued: 1, skipped: 0 }]);
    render(<WorkspaceShell />);
    await openImportDrawer();
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    await waitFor(() => expect(webview.dropHandler).not.toBeNull());
    expect(screen.queryByText("松开即导入")).toBeNull();
    act(() => webview.dropHandler!({ payload: { type: "enter" } }));
    const overlay = within(dialog).getByText("松开即导入").closest("[role='status']");
    expect(overlay).not.toBeNull();
    await act(async () => {
      webview.dropHandler!({ payload: { type: "drop", paths: ["/a/1.mp4"] } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMocks.importPaths).toHaveBeenCalledWith(["/a/1.mp4"]);
    expect(screen.queryByText("松开即导入")).toBeNull();
    expect(await within(dialog).findByText("已发现 1 个视频，新增 1 项")).toBeTruthy();
  });

  it("抽屉里不渲染素材清单(素材在媒体池)", async () => {
    render(<WorkspaceShell />);
    await openImportDrawer();
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    expect(dialog.querySelector(".import-list")).toBeNull();
    expect(dialog.querySelector(".clip-table")).toBeNull();
    expect(dialog.querySelector(".import-panel")).toBeNull();
  });

  it("切分页走 Tabs(tablist「导入分页」),← → 键盘也能换", async () => {
    render(<WorkspaceShell />);
    await openImportDrawer();
    const list = await screen.findByRole("tablist", { name: "导入分页" });
    await act(async () => {
      within(list).getByRole("tab", { name: "任务" }).click();
      await Promise.resolve();
    });
    expect(within(list).getByRole("tab", { name: "任务", selected: true })).toBeTruthy();
    expect(await screen.findByText("索引进度")).toBeTruthy();
  });
});

describe("导入抽屉:来源分页是工作面(控制端复审)", () => {
  it("拖放区卡:「把文件夹拖到这里」+ secondary「选择文件夹」走同一 pickImportFolder;拖入时卡片高亮", async () => {
    apiMocks.pickImportFolder.mockResolvedValue(null);
    render(<WorkspaceShell />);
    await openImportDrawer();
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    expect(within(dialog).getByText("把文件夹拖到这里")).toBeTruthy();
    const zone = dialog.querySelector(".import-dropzone")!;
    expect(zone.className).not.toContain("import-dropzone--active");
    await act(async () => {
      within(dialog).getByRole("button", { name: "选择文件夹" }).click();
      await Promise.resolve();
    });
    expect(apiMocks.pickImportFolder).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(webview.dropHandler).not.toBeNull());
    act(() => webview.dropHandler!({ payload: { type: "enter" } }));
    expect(zone.className).toContain("import-dropzone--active");
  });

  it("「最近导入」卡只列最近 3 批(名 · 状态 · 计数),「查看全部任务」切到任务分页", async () => {
    apiMocks.listImportBatches.mockResolvedValue([
      { id: 4, source: "/v/2026-08-15", status: "scanning", total: 16, done: 14, running: 2, failed: 0, duplicates: 0, imported: 14 },
      { id: 3, source: "/v/2026-08-14", status: "failed", total: 16, done: 16, running: 0, failed: 1, duplicates: 0, imported: 15 },
      { id: 2, source: "/v/2026-08-13", status: "completed", total: 16, done: 16, running: 0, failed: 0, duplicates: 1, imported: 15 },
      { id: 1, source: "/v/2026-08-12", status: "completed", total: 12, done: 12, running: 0, failed: 0, duplicates: 0, imported: 12 },
    ]);
    render(<WorkspaceShell />);
    await openImportDrawer();
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    const recent = await within(dialog).findByRole("region", { name: "最近导入" });
    expect(await within(recent).findByText("2026-08-15")).toBeTruthy();
    expect(within(recent).getByText("2026-08-13")).toBeTruthy();
    expect(within(recent).queryByText("2026-08-12")).toBeNull();
    expect(within(recent).getByText("正在扫描").closest(".ui-badge")).not.toBeNull();
    expect(within(recent).getByText("扫描未完成，可重试").closest(".ui-badge")?.className).toContain("ui-badge--danger");
    expect(within(recent).getByText("新增 14 · 14 / 16")).toBeTruthy();
    // 「最近导入」卡里没有停止 / 撤销:操作只在任务分页。
    expect(within(recent).queryByRole("button", { name: "停止本批" })).toBeNull();
    await act(async () => {
      within(recent).getByRole("button", { name: "查看全部任务" }).click();
      await Promise.resolve();
    });
    expect(within(dialog).getByRole("tab", { name: "任务", selected: true })).toBeTruthy();
  });

  it("没有批次时「最近导入」卡说明还没导入过", async () => {
    apiMocks.listImportBatches.mockResolvedValue([]);
    render(<WorkspaceShell />);
    await openImportDrawer();
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    const recent = await within(dialog).findByRole("region", { name: "最近导入" });
    expect(await within(recent).findByText("还没有导入过素材")).toBeTruthy();
  });
});
