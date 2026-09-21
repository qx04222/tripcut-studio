// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestApiMock } from "./testApiMock";
import { photoFixture } from "./photoTestFixtures";
import { __resetClipsFeedForTests } from "./useClipsFeed";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";
const api = vi.hoisted(() => ({ listClips: vi.fn(), getAiDescription: vi.fn(async () => null), getClipBrief: vi.fn(async () => null), listAudioTracks: vi.fn(async () => []), getSettings: vi.fn(async () => ({ "ui.show_all_features": "true" })) }));
vi.mock("../api", async () => ({ ...await createTestApiMock(), ...api }));
import { __setShowAllFeaturesForTests } from "./showAllFeatures";
import { Inspector } from "./Inspector";
beforeEach(() => {
  __setShowAllFeaturesForTests(true);
  __resetClipsFeedForTests();
  __resetWorkspaceForTests({ selection: { kind: "clip", clipId: 2 }, inspectorSections: ["techcheck", "audio"] });
  api.listClips.mockResolvedValue([photoFixture]);
});
afterEach(() => { cleanup(); __resetClipsFeedForTests(); vi.clearAllMocks(); });
it("PH-03 inspector: photo EXIF metadata without frame rate, bitrate, timebase or audio probes", async () => {
  const { container } = render(<Inspector />);
  await waitFor(() => expect(screen.getByRole("group", { name: "照片信息" })).toBeTruthy());
  const metadata = screen.getByRole("group", { name: "照片信息" });
  // 拍摄时间显示本地钟原文(带 offset),不是排序用的 UTC 值。
  for (const text of ["3024×4032", "2026-08-12T16:00:00+08:00", "Sony A7R III", "35mm", "25.7, 100.2"]) expect(metadata.textContent).toContain(text);
  expect(metadata.textContent).not.toContain("08:00:00Z");
  expect(container.textContent).not.toMatch(/帧率|码率|时基|NaN|Infinity/);
  expect(api.listAudioTracks).not.toHaveBeenCalled();
});
it("PH-03 inspector: absent optional EXIF fields stay absent", async () => {
  api.listClips.mockResolvedValue([{ ...photoFixture, photo: { width: 100, height: 100, orientation: 1, taken_at: null, taken_at_local: null, tz_guess: null, hold_ms: 3000 } }]);
  render(<Inspector />);
  const metadata = await screen.findByRole("group", { name: "照片信息" });
  expect(metadata.textContent).toContain("100×100");
  expect(metadata.textContent).not.toMatch(/机身|镜头|GPS|拍摄时间/);
});
it("照片检查器不显示加入视频镜头带入口", async () => {
  render(<Inspector />);
  await screen.findByRole("group", { name: "照片信息" });
  expect(screen.queryByRole("button", { name: "加入当前章节" })).toBeNull();
});
it("照片检查器更多菜单不提供加入视频镜头带动作", async () => {
  render(<Inspector />);
  await screen.findByRole("group", { name: "照片信息" });
  fireEvent.click(screen.getByRole("button", { name: "更多" }));
  const menu = await screen.findByRole("menu", { name: "素材操作" });
  expect(Array.from(menu.querySelectorAll("[role='menuitem']")).map((node) => node.getAttribute("aria-label"))).not.toContain("加入镜头带");
});
it("照片检查器上一条/下一条只在照片内导航并按照片数量判断边界", async () => {
  const nextPhoto = { ...photoFixture, id: 3, file_name: "next.jpg" };
  api.listClips.mockResolvedValue([
    { ...photoFixture, id: 1, kind: "video", file_name: "video.mov" },
    photoFixture,
    { ...photoFixture, id: 4, kind: undefined, file_name: "unknown.jpg" },
    nextPhoto,
  ]);
  render(<Inspector />);
  await screen.findByRole("group", { name: "照片信息" });
  expect((screen.getByRole("button", { name: "上一条" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "下一条" }));
  expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 3 });
  await waitFor(() => expect((screen.getByRole("button", { name: "下一条" }) as HTMLButtonElement).disabled).toBe(true));
});
