// R14 车道 stress · Z-13:跨集同内容不再当重复拒收;同路径已属于别的集时任务页说清「这 n 个文件已在「EP01」里」。
// @vitest-environment jsdom
import { act } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({
    getCurrentEpisode: vi.fn(async () => ({ id: 2, title: "EP02", theme: "通用" })),
    getClipsRevision: vi.fn(async () => "rev-0"),
    getClipArtifacts: vi.fn(async () => ({})),
  });
});
vi.mock("../api", () => apiMocks);
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import type { ClipListItem } from "../api";
import { ownedElsewhereLines } from "./import/importModel";
import { __resetClipsFeedForTests } from "./useClipsFeed";
import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests, dispatchWorkspace } from "./WorkspaceStore";

function placeholder(name: string, error: string | null, status: ClipListItem["status"] = "duplicate"): ClipListItem {
  return {
    id: null,
    episode_id: 2,
    folder_label: null,
    cover_url: null,
    path: `/Volumes/CARD/${name}`,
    file_name: name,
    byte_size: null,
    quick_hash: null,
    full_hash: null,
    tb_num: null,
    tb_den: null,
    duration_ticks: null,
    fps_num: null,
    fps_den: null,
    is_vfr: false,
    codec: null,
    width: null,
    height: null,
    captured_at: null,
    status,
    error,
    analysis: null,
    analysis_status: null,
    analysis_error: null,
    motion: null,
    motion_status: null,
    motion_error: null,
    binary_rating: null,
    star_rating: null,
    select_count: 0,
  };
}

const clips = [
  placeholder("IMG_0830.mov", "这个文件已在「EP01」里,可在那一集里找到"),
  placeholder("IMG_0831.mov", "这个文件已在「EP01」里,可在那一集里找到"),
  placeholder("IMG_0832.mov", "这个文件已在「EP01」里,可在那一集里找到"),
  placeholder("IMG_0900.mov", "已存在相同素材，未重复导入"),
  placeholder("broken.mp4", "ffprobe 失败", "unreadable"),
];

beforeEach(() => {
  vi.clearAllMocks();
  __resetWorkspaceForTests();
  __resetClipsFeedForTests();
  apiMocks.listWatchedFolders.mockResolvedValue([]);
  apiMocks.listImportBatches.mockResolvedValue([
    { id: 7, source: "/Volumes/CARD/s5-ep2", status: "done", total: 8, done: 8, running: 0, failed: 0, duplicates: 3, imported: 5 } as never,
  ]);
  apiMocks.listMissingClips.mockResolvedValue([]);
  apiMocks.listClips.mockResolvedValue(clips);
});
afterEach(cleanup);

describe("ownedElsewhereLines(Z-13)", () => {
  it("按集名归堆:3 条 EP01 → 一句;同一集里的普通重复与失败项不算", () => {
    expect(ownedElsewhereLines(clips)).toEqual(["这 3 个文件已在「EP01」里,可在那一集里找到"]);
    expect(ownedElsewhereLines([])).toEqual([]);
  });
});

describe("任务页(Z-13)", () => {
  it("批次行下面列出「这 3 个文件已在「EP01」里,可在那一集里找到」", async () => {
    render(<WorkspaceShell />);
    await act(async () => {
      dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "jobs" });
      await Promise.resolve();
    });
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    const list = await within(dialog).findByRole("list", { name: "已属于其他集的文件" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["这 3 个文件已在「EP01」里,可在那一集里找到"]);
  });
});
