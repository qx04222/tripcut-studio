// @vitest-environment jsdom
/**
 * R21 W3 验收 P1-2:状态条在照片工作台说「N 张 · 已选 M 张 · 正在分析 x/y」,不说视频的
 * 「已导入 N 条 · 共 N 分钟」;切回视频工作台原样。
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMocks);
const feedState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("./useClipsFeed", () => ({ useClipsFeed: () => feedState.current, refreshClipsFeed: vi.fn(async () => undefined), patchClipInFeed: vi.fn() }));

import type { ClipListItem } from "../api";
import { photoFixture, videoFixture } from "./photoTestFixtures";
import { StatusStrip, photoStatusPhrase, summaryPhrases } from "./StatusStrip";
import { __resetWorkspaceForTests, dispatchWorkspace } from "./WorkspaceStore";

function photos(count: number, patch: Partial<ClipListItem> = {}): ClipListItem[] {
  return Array.from({ length: count }, (_, index) => ({ ...photoFixture, id: 1 + index, file_name: `p${index}.HEIC`, binary_rating: null, star_rating: null, select_count: 0, ...patch }));
}
function videos(count: number): ClipListItem[] {
  return Array.from({ length: count }, (_, index) => ({ ...videoFixture, id: 100 + index, file_name: `v${index}.mov` }));
}
function setFeed(clips: ClipListItem[]) {
  feedState.current = { clips, clipsById: new Map(clips.map((clip) => [clip.id!, clip])), storyboard: null, episode: { scopeId: 7, current: null }, loading: false };
}

beforeEach(() => {
  __resetWorkspaceForTests();
  apiMocks.getImportProgress.mockResolvedValue({ total: 70, done: 50, failed: 0, running: 20, waiting_for_permit: 0, paused_for_memory: false });
  apiMocks.listMissingClips.mockResolvedValue([]);
  apiMocks.listGenerationRequests.mockResolvedValue([]);
});
afterEach(cleanup);

describe("状态条 · 照片工作台(R21 W3 P1-2)", () => {
  it("photoStatusPhrase / summaryPhrases:「60 张 · 已选 8 张 · 正在分析 40/60」;分析完只剩「60 张 · 已选 8 张」;不说分钟", () => {
    expect(photoStatusPhrase({ count: 60, selected: 8, analysed: 40 }, null)).toBe("60 张 · 已选 8 张 · 正在分析 40/60");
    expect(photoStatusPhrase({ count: 60, selected: 8, analysed: 40 }, "30 秒")).toBe("60 张 · 已选 8 张 · 正在分析 40/60(约 30 秒)");
    expect(photoStatusPhrase({ count: 60, selected: 0, analysed: 60 }, null)).toBe("60 张 · 已选 0 张");
    const idle = { analyzed: 40, analyzeTotal: 70, transcribing: 0, generating: 0, missing: 0 };
    // 照片摘要在场时取代「已导入 N 条 · 共 X 分钟」,即便调用方同时传了 importedCount。
    expect(summaryPhrases({ ...idle, importedCount: 70, importedDurationMs: 620_000, photoSummary: { count: 60, selected: 8, analysed: 40 } }))
      .toEqual(["60 张 · 已选 8 张 · 正在分析 40/60"]);
  });

  it("照片工作台:状态条显示「60 张 · 已选 8 张 · 正在分析 40/60」,没有「共 N 分钟」「已导入 N 条」", async () => {
    dispatchWorkspace({ type: "set-workspace-mode", mode: "photo" });
    setFeed([...photos(32), ...photos(8, { binary_rating: 1 }), ...photos(20, { analysis_status: "running" }), ...videos(10)]);
    render(<StatusStrip />);
    const status = await screen.findByRole("status", { name: "后台状态" });
    await screen.findByText("60 张 · 已选 8 张 · 正在分析 40/60");
    expect(status.textContent).not.toMatch(/分钟|已导入|条|交付|段|章/);
  });

  it("视频工作台原样:「已导入 70 条 · 共 N 分钟 …」", async () => {
    setFeed([...photos(60), ...videos(10)]);
    render(<StatusStrip />);
    await screen.findByText(/^已导入 70 条 · 共 \d+ 分钟/);
  });
});
