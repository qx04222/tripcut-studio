// @vitest-environment jsdom
/**
 * R21 照片线(业主拍板:照片不套视频那一套):照片工作台的真 DOM —— 网格、静态检视、一句话挑照片、
 * 精选带、以及照片工作台里的导出抽屉正文 —— 不许出现 剪映 / 镜头带 / 章节 / 秒 / 交付 这套视频词。
 * 静态扫源文件的那份在 terminology.test;这里是渲染后的文本 + aria-label / title / placeholder。
 */
import type { JSX } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({})), setSetting: vi.fn(async () => undefined),
  listSimilarGroups: vi.fn(async () => []), setSimilarPrimary: vi.fn(async () => undefined),
  rateClip: vi.fn(async () => undefined), clearClipRating: vi.fn(async () => undefined), setShotStackUserState: vi.fn(async () => undefined),
  planSelectedPhotos: vi.fn(async () => ({ job_id: null, dir: "/Users/mock/Desktop/EP01_精选照片_2026-09-20", files: ["01_one.jpg", "02_two.jpg"], order_file: "顺序.txt" })),
  getExportStatus: vi.fn(async () => null),
  // 壳(顶栏 / 状态条)一挂载就轮询的几条。
  listEpisodes: vi.fn(async () => []), getCurrentEpisode: vi.fn(async () => null),
  getImportProgress: vi.fn(async () => ({ total: 3, done: 3, failed: 0, running: 0, waiting_for_permit: 0, paused_for_memory: false })),
  listMissingClips: vi.fn(async () => []), listGenerationRequests: vi.fn(async () => []), getMusicAnalysisProgress: vi.fn(async () => null),
  listLibraries: vi.fn(async () => []),
}));
vi.mock("../api", async (original) => ({ ...(await original()), ...api }));
const archiveApi = vi.hoisted(() => ({
  listArchives: vi.fn(async () => [{ id: "op", kind: "photo", status: "partial", destination: "/test/export", job_id: 1, needs_preparation: false, errors: ["磁盘不可用"] }]),
  resumeArchive: vi.fn(), undoArchive: vi.fn(),
}));
vi.mock("./deliver/archiveApi", () => archiveApi);
const feedState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("./useClipsFeed", () => ({ useClipsFeed: () => feedState.current, refreshClipsFeed: vi.fn(async () => undefined), patchClipInFeed: vi.fn() }));
import { photoFixture } from "./photoTestFixtures";
import { PhotoWorkspace } from "./PhotoWorkspace";
import { PhotoExportFooter, PhotoExportPanel } from "./deliver/PhotoExportPanel";
import { usePhotoExport } from "./deliver/usePhotoExport";
import { EMPTY_STATUS } from "./deliver/deliverModel";
import type { ExportProgress } from "./deliver/useExportProgress";
import { __resetPhotoOrderPersistenceForTests } from "./photoOrderSettings";
import { __resetPoolOrderForTests } from "./poolOrder";
import { __resetWorkspaceForTests, dispatchWorkspace } from "./WorkspaceStore";
import { ArchiveRecoveryEntry } from "./deliver/ArchiveRecoveryEntry";
import { StatusStrip } from "./StatusStrip";
import { TopBar } from "./TopBar";

/**
 * 业主点名的五个词 + 照片线不该借用的几个视频概念。R21 W3 验收补「段 / 章 / 分钟」(壳里的
 * 「挑选 N 段 · 排列 N 章」「共 N 分钟」);「时段」是照片网格自己的分组词,放行。
 */
export const PHOTO_WORKSPACE_FORBIDDEN = /剪映|镜头带|(?<!时)段|章|秒|分钟|交付|素材包|整包|粗剪|镜头表|快速导出/;

const photos = [
  { ...photoFixture, id: 1, file_name: "one.jpg", binary_rating: 1 as const },
  { ...photoFixture, id: 2, file_name: "two.HEIC", star_rating: 4, binary_rating: null },
  { ...photoFixture, id: 3, file_name: "three.jpg" },
];
const NativeResizeObserver = globalThis.ResizeObserver;
beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  const clipsById = new Map(photos.map((clip) => [clip.id!, clip]));
  feedState.current = { clips: photos, clipsById, shotStackByClipId: new Map(), gaps: [], loading: false, storyboard: null, episode: { scopeId: 7, current: null } };
  __resetPoolOrderForTests(); __resetWorkspaceForTests(); __resetPhotoOrderPersistenceForTests(); vi.clearAllMocks();
});
afterEach(() => { cleanup(); globalThis.ResizeObserver = NativeResizeObserver; });

/** 可见文本 + 可读属性(aria-label / title / placeholder / alt)一起扫。 */
function visibleStrings(root: HTMLElement): string[] {
  const strings = [root.textContent ?? ""];
  for (const element of root.querySelectorAll<HTMLElement>("[aria-label], [title], [placeholder], [alt]")) {
    for (const attr of ["aria-label", "title", "placeholder", "alt"]) {
      const value = element.getAttribute(attr);
      if (value) strings.push(value);
    }
  }
  return strings;
}

function offenders(root: HTMLElement): string[] {
  return visibleStrings(root).filter((text) => PHOTO_WORKSPACE_FORBIDDEN.test(text)).map((text) => text.match(PHOTO_WORKSPACE_FORBIDDEN)![0] + " ← " + text.slice(0, 80));
}

it("照片工作台 DOM 不含 剪映 / 镜头带 / 章节 / 秒 / 交付", async () => {
  render(<PhotoWorkspace />);
  const main = await screen.findByRole("main", { name: "照片工作台" });
  await waitFor(() => expect(screen.getByRole("region", { name: "照片精选带" }).querySelectorAll('[role="listitem"]').length).toBe(2));
  expect(offenders(main)).toEqual([]);
});

function PhotoDrawerProbe(): JSX.Element {
  const progress = { status: { ...EMPTY_STATUS, selected_count: 2, selected_photo_count: 2 }, active: false, error: null, setJobId: () => undefined, refresh: async () => undefined } as unknown as ExportProgress;
  const exporter = usePhotoExport(progress);
  return <div data-testid="photo-drawer"><PhotoExportPanel photos={exporter} status={progress.status} /><PhotoExportFooter photos={exporter} status={progress.status} onClose={() => undefined} /></div>;
}

it("照片工作台的导出抽屉正文只说照片,不说 剪映 / 素材包 / 整包 / 交付", async () => {
  render(<PhotoDrawerProbe />);
  await waitFor(() => expect(screen.getByRole("list", { name: "将导出的照片" })).toBeTruthy());
  expect(offenders(screen.getByTestId("photo-drawer"))).toEqual([]);
  expect(screen.getByRole("button", { name: "导出精选照片到上次文件夹" })).toBeTruthy();
});

/**
 * R21 W3 验收:壳也要扫 —— 照片工作台的顶栏(流水线 rail + 「下一步」)、状态条、导出抽屉里的归档恢复入口。
 * 校准:对 2946526(rail 仍是视频四步「挑选 N 段 · 排列 N 章」、状态条「共 N 分钟」、入口「上次交付未完成」)红。
 */
it("照片工作台的壳(顶栏 / 状态条 / 归档恢复入口)不含 段 / 章 / 分钟 / 交付", async () => {
  dispatchWorkspace({ type: "set-workspace-mode", mode: "photo" });
  render(<div data-testid="shell"><TopBar /><StatusStrip /><ArchiveRecoveryEntry variant="photo" /></div>);
  await screen.findByRole("navigation", { name: "照片流水线" });
  await screen.findByText(/^3 张 · 已选/);
  await screen.findByText(/上次导出未完成/);
  expect(offenders(screen.getByTestId("shell"))).toEqual([]);
});
