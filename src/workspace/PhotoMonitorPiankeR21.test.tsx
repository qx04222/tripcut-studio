// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestApiMock } from "./testApiMock";
import { photoFixture } from "./photoTestFixtures";
import { __resetPoolOrderForTests, setPoolOrder } from "./poolOrder";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";

const mocks = vi.hoisted(() => ({
  listSimilarGroups: vi.fn(),
  rateClip: vi.fn(),
  setSimilarPrimary: vi.fn(),
  refresh: vi.fn(),
  requestDuel: vi.fn(),
  notifySimilarGroupsChanged: vi.fn(),
}));
vi.mock("../api", async () => ({
  ...(await createTestApiMock()),
  listSimilarGroups: mocks.listSimilarGroups,
  rateClip: mocks.rateClip,
  setSimilarPrimary: mocks.setSimilarPrimary,
}));
vi.mock("./useClipsFeed", () => ({ refreshClipsFeed: mocks.refresh }));
vi.mock("./duel/duelBus", () => ({
  requestDuel: mocks.requestDuel,
  notifySimilarGroupsChanged: mocks.notifySimilarGroupsChanged,
}));

import { PhotoMonitor } from "./PhotoMonitor";

const second = {
  ...photoFixture,
  id: 3,
  file_name: "second.jpg",
  binary_rating: -1 as const,
  iso_value: 640,
  shutter_speed: "1/250",
  aperture: "f/2.8",
  analysis: {
    underexposed_ratio: 0.2,
    overexposed_ratio: 0,
    out_of_focus_ratio: 0,
  } as typeof photoFixture.analysis,
};
const third = { ...photoFixture, id: 4, file_name: "third.jpg" };

beforeEach(() => {
  __resetWorkspaceForTests({ workspaceMode: "photo", selection: { kind: "clip", clipId: 2 } });
  __resetPoolOrderForTests();
  setPoolOrder([2, 3]);
  mocks.listSimilarGroups.mockResolvedValue([{ id: 8, min_similarity: 0.94, members: [{ clip_id: 2, is_primary: true }, { clip_id: 3, is_primary: false }] }]);
  mocks.rateClip.mockResolvedValue({});
  mocks.setSimilarPrimary.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); __resetPoolOrderForTests(); __resetWorkspaceForTests(); });

it("shows a photo-native header, position, EXIF strip and no video transport vocabulary", async () => {
  render(<PhotoMonitor clip={second} clips={[photoFixture, second]} rootRef={{ current: null }} />);
  expect(screen.getByText("照片检视")).toBeTruthy();
  expect(screen.getByText("2 / 2")).toBeTruthy();
  for (const text of ["3024×4032", "2026-08-12T16:00:00+08:00", "Sony A7R III", "35mm", "ISO 640", "1/250", "f/2.8", "疑似废片"]) {
    expect(screen.getByText(text)).toBeTruthy();
  }
  for (const name of ["适屏", "100%", "200%", "400%", "保留 F", "拒绝 X", "1 星", "2 星", "3 星", "4 星", "5 星"]) expect(screen.getByRole("button", { name })).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/播放|入点|出点|timecode|hold_ms/iu);
  const duel = await screen.findByRole("button", { name: "组内对比 1 张" });
  expect((duel as HTMLButtonElement).disabled).toBe(true);
  expect(duel.getAttribute("title")).toContain("先按 F 保留、清除评级，或换一张");
});

it("navigates with arrows, cycles Z zoom, pans while enlarged and resets on photo change", () => {
  const view = render(<PhotoMonitor clip={photoFixture} clips={[photoFixture, second]} rootRef={{ current: null }} />);
  fireEvent.pointerEnter(screen.getByLabelText("照片检视器"));
  fireEvent.keyDown(document, { key: "ArrowRight" });
  expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 3 });
  fireEvent.keyDown(document, { key: "z" });
  expect(screen.getByRole("button", { name: "100%" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.keyDown(document, { key: "z" });
  expect(screen.getByRole("button", { name: "200%" }).getAttribute("aria-pressed")).toBe("true");
  const viewer = screen.getByRole("group", { name: "照片查看区" });
  fireEvent.pointerDown(viewer, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(viewer, { pointerId: 1, clientX: 42, clientY: 31 });
  fireEvent.pointerUp(viewer, { pointerId: 1 });
  expect(screen.getByRole("img", { name: /照片预览/ }).getAttribute("style")).toMatch(/translate\(32px, 21px\).*scale\(2\)/);
  const wheel = new WheelEvent("wheel", { deltaY: -1, cancelable: true });
  viewer.dispatchEvent(wheel);
  expect(wheel.defaultPrevented).toBe(true);
  view.rerender(<PhotoMonitor clip={second} clips={[photoFixture, second]} rootRef={{ current: null }} />);
  expect(screen.getByRole("button", { name: "适屏" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("img", { name: /照片预览/ }).getAttribute("style")).not.toContain("translate(32px");
});

it("only handles photo shortcuts while its own focus or pointer scope is active", async () => {
  const gridKey = vi.fn();
  render(<>
    <div role="grid" aria-label="外部照片网格" tabIndex={0} onKeyDown={gridKey}>网格</div>
    <button type="button">交付抽屉</button>
    <PhotoMonitor clip={photoFixture} clips={[photoFixture, second]} rootRef={{ current: null }} />
  </>);
  const grid = screen.getByRole("grid", { name: "外部照片网格" });
  fireEvent.pointerEnter(screen.getByLabelText("照片检视器"));
  grid.focus();
  fireEvent.keyDown(grid, { key: "ArrowRight", shiftKey: true });
  fireEvent.keyDown(grid, { key: "f" });
  fireEvent.keyDown(grid, { key: "x" });
  expect(gridKey).toHaveBeenCalledTimes(3);
  expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 2 });
  expect(mocks.rateClip).not.toHaveBeenCalled();

  const drawer = screen.getByRole("button", { name: "交付抽屉" });
  drawer.focus();
  fireEvent.keyDown(drawer, { key: "ArrowRight" });
  expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 2 });

  const monitor = screen.getByLabelText("照片检视器");
  monitor.focus();
  fireEvent.keyDown(monitor, { key: "ArrowRight" });
  expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 3 });
  fireEvent.keyDown(monitor, { key: "f" });
  await waitFor(() => expect(mocks.rateClip).toHaveBeenCalledWith(2, "binary", 1));
});

it("rates F/X, refreshes the feed, exposes busy/active state and starts the current similar group", async () => {
  let release: (() => void) | undefined;
  mocks.rateClip.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({}); }));
  mocks.listSimilarGroups.mockResolvedValueOnce([{ id: 8, min_similarity: 0.94, members: [{ clip_id: 2, is_primary: true }, { clip_id: 3, is_primary: false }, { clip_id: 4, is_primary: false }] }]);
  render(<PhotoMonitor clip={photoFixture} clips={[photoFixture, second, third]} rootRef={{ current: null }} />);
  fireEvent.pointerEnter(screen.getByLabelText("照片检视器"));
  const keep = screen.getByRole("button", { name: "保留 F" });
  fireEvent.click(keep);
  expect(keep.getAttribute("aria-busy")).toBe("true");
  expect(mocks.rateClip).toHaveBeenCalledWith(2, "binary", 1);
  await act(async () => release?.());
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledWith(true));
  fireEvent.keyDown(document, { key: "x" });
  await waitFor(() => expect(mocks.rateClip).toHaveBeenCalledWith(2, "binary", -1));
  fireEvent.click(screen.getByRole("button", { name: "4 星" }));
  await waitFor(() => expect(mocks.rateClip).toHaveBeenCalledWith(2, "star", 4));
  await waitFor(() => fireEvent.click(screen.getByRole("button", { name: "组内对比 2 张" })));
  expect(mocks.requestDuel).toHaveBeenCalledWith({ clipIds: [2, 4], source: "similar_group" });
});

it("rates 1–5 from the focused photo monitor without hijacking editable controls", async () => {
  render(<>
    <input aria-label="照片备注" />
    <div aria-label="照片说明" contentEditable suppressContentEditableWarning>可编辑说明</div>
    <PhotoMonitor clip={photoFixture} clips={[photoFixture, second]} rootRef={{ current: null }} />
  </>);
  const monitor = screen.getByLabelText("照片检视器");
  monitor.focus();
  for (const star of [1, 2, 3, 4, 5]) {
    fireEvent.keyDown(monitor, { key: String(star), code: `Digit${star}` });
    await waitFor(() => expect(mocks.rateClip).toHaveBeenCalledWith(2, "star", star));
    await waitFor(() => expect(screen.getByRole("button", { name: `${star} 星` }).getAttribute("aria-busy")).toBeNull());
  }

  mocks.rateClip.mockClear();
  const input = screen.getByRole("textbox", { name: "照片备注" });
  input.focus();
  fireEvent.keyDown(input, { key: "4", code: "Digit4" });
  const editable = screen.getByLabelText("照片说明");
  editable.focus();
  fireEvent.keyDown(editable, { key: "5", code: "Digit5" });
  expect(mocks.rateClip).not.toHaveBeenCalled();
});

it("marks a non-primary photo as the similar-group primary and refreshes", async () => {
  render(<PhotoMonitor clip={second} clips={[photoFixture, second]} rootRef={{ current: null }} />);
  const primary = await screen.findByRole("button", { name: "设为主图" });
  fireEvent.click(primary);
  await waitFor(() => expect(mocks.setSimilarPrimary).toHaveBeenCalledWith(8, 3));
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledWith(true));
});

it("disables all mutating photo actions in a read-only historical episode", async () => {
  __resetWorkspaceForTests({ workspaceMode: "photo", viewingEpisode: { id: 7, title: "往集" } });
  render(<PhotoMonitor clip={photoFixture} clips={[photoFixture, second]} rootRef={{ current: null }} />);
  fireEvent.pointerEnter(screen.getByLabelText("照片检视器"));
  for (const name of ["保留 F", "拒绝 X", "1 星", "2 星", "3 星", "4 星", "5 星"]) expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
  expect((await screen.findByRole("button", { name: "组内对比 1 张" })).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("本组主图")).toBeTruthy();
  fireEvent.keyDown(document, { key: "f" });
  expect(mocks.rateClip).not.toHaveBeenCalled();
});
