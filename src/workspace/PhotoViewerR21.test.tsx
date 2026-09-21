// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createTestApiMock } from "./testApiMock";
import { PhotoMonitor } from "./PhotoMonitor";
import { photoFixture, videoFixture } from "./photoTestFixtures";
import { __resetPoolOrderForTests, setPoolOrder } from "./poolOrder";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";
vi.mock("../api", async () => createTestApiMock());
afterEach(() => { cleanup(); __resetPoolOrderForTests(); __resetWorkspaceForTests(); vi.clearAllMocks(); });
it("photo navigation follows visible pool order, skips videos and stops at the edge", () => {
  const next = { ...photoFixture, id: 3 };
  setPoolOrder([2, 1, 3]);
  const props = { rootRef: { current: null }, clips: [next, videoFixture, photoFixture] };
  const view = render(<PhotoMonitor {...props} clip={photoFixture} />);
  expect(screen.getByRole("button", { name: "上一张" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "下一张" }));
  expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 3 });
  view.rerender(<PhotoMonitor {...props} clip={next} />);
  expect(screen.getByRole("button", { name: "下一张" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "上一张" }));
  expect(getWorkspaceSnapshot().selection).toEqual({ kind: "clip", clipId: 2 });
});
// DTO 对齐(r21/integrate):预览图只来自 list_clips 的 `photo.preview_url`(photo-core 的形状),
// get_clip_artifacts 不吐 preview,组件不再二次取图;签名 URL 原样消费。
it("signed preview URL from photo.preview_url is consumed verbatim; broken images have a status", () => {
  const url = "http://127.0.0.1/cache/2/preview.jpg?expires=999&signature=unchanged";
  const photo = { ...photoFixture, photo: { ...photoFixture.photo!, preview_url: url } };
  render(<PhotoMonitor clip={photo} clips={[photo]} rootRef={{ current: null }} />);
  const img = screen.getByRole("img", { name: /照片预览/ });
  expect(img.getAttribute("src")).toBe(url);
  fireEvent.error(img);
  expect(screen.getByRole("status").textContent).toBe("照片预览加载失败");
});
it("without preview_url the monitor falls back to cover_url; switching photo switches the image", () => {
  const first = { ...photoFixture, photo: { ...photoFixture.photo!, preview_url: null } };
  const view = render(<PhotoMonitor clip={first} clips={[]} rootRef={{ current: null }} />);
  expect(screen.getByRole("img", { name: /照片预览/ }).getAttribute("src")).toBe(first.cover_url);
  view.rerender(<PhotoMonitor clip={{ ...photoFixture, id: 3, photo: { ...photoFixture.photo!, preview_url: "/next.jpg" } }} clips={[]} rootRef={{ current: null }} />);
  expect(screen.getByRole("img", { name: /照片预览/ }).getAttribute("src")).toBe("/next.jpg");
});
