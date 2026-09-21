// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
let resolveSettings: (value: Record<string, string>) => void = () => undefined;
const api = vi.hoisted(() => ({ getSettings: vi.fn(), setSetting: vi.fn(async () => undefined) }));
vi.mock("../api", async (original) => ({ ...(await original()), ...api }));
const feedState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("./useClipsFeed", () => ({ useClipsFeed: () => feedState.current }));
import { photoFixture } from "./photoTestFixtures";
import { PhotoFeaturedStrip } from "./PhotoFeaturedStrip";
import { __resetPhotoOrderPersistenceForTests } from "./photoOrderSettings";
import { __resetToastsForTests, getToastSnapshot } from "./ui/toastStore";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

beforeEach(() => {
  api.getSettings.mockImplementation(() => new Promise((resolve) => { resolveSettings = resolve; }));
  const first = { ...photoFixture, id: 1, file_name: "one.jpg", binary_rating: 1 as const };
  const second = { ...photoFixture, id: 2, file_name: "two.jpg", binary_rating: 1 as const };
  feedState.current = { clips: [first, second], episode: { scopeId: 7 } };
  __resetWorkspaceForTests();
  __resetPhotoOrderPersistenceForTests();
  __resetToastsForTests();
  vi.clearAllMocks();
});
afterEach(cleanup);

it("用户重排后迟到的 getSettings 不覆盖新顺序，最终顺序落盘", async () => {
  render(<PhotoFeaturedStrip />);
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
  expect(api.getSettings).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "后移 · one.jpg" }));
  await waitFor(() => expect(api.setSetting).toHaveBeenCalledWith("ui.photo.order.7", "[2,1]"));
  await act(async () => resolveSettings({ "ui.photo.order.7": "[1,2]" }));
  await waitFor(() => {
    const items = screen.getAllByRole("listitem");
    expect(within(items[0]!).getByRole("button", { name: "检视照片 · two.jpg" })).toBeTruthy();
  });
});

it("前移可见候选时一次跨过隐藏顺序项，并保留隐藏 id 的位置", async () => {
  const first = { ...photoFixture, id: 1, file_name: "one.jpg", binary_rating: 1 as const };
  const hidden = { ...photoFixture, id: 2, file_name: "hidden.jpg", binary_rating: null };
  const third = { ...photoFixture, id: 3, file_name: "three.jpg", binary_rating: 1 as const };
  feedState.current = { clips: [first, hidden, third], episode: { scopeId: 7 } };
  render(<PhotoFeaturedStrip />);
  await act(async () => resolveSettings({ "ui.photo.order.7": "[1,2,3]" }));
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
  fireEvent.click(screen.getByRole("button", { name: "前移 · three.jpg" }));
  await waitFor(() => expect(api.setSetting).toHaveBeenCalledWith("ui.photo.order.7", "[3,2,1]"));
  const items = screen.getAllByRole("listitem");
  expect(within(items[0]!).getByRole("button", { name: "检视照片 · three.jpg" })).toBeTruthy();
});

it("非相邻拖放按插入语义移动可见项，并把隐藏 id 留在原槽位", async () => {
  const visible = [1, 2, 3, 4].map((id) => ({ ...photoFixture, id, file_name: `${String.fromCharCode(64 + id)}.jpg`, binary_rating: 1 as const }));
  const hidden = { ...photoFixture, id: 99, file_name: "hidden.jpg", binary_rating: null };
  feedState.current = { clips: [visible[0], hidden, ...visible.slice(1)], episode: { scopeId: 7 } };
  render(<PhotoFeaturedStrip />);
  await act(async () => resolveSettings({ "ui.photo.order.7": "[1,99,2,3,4]" }));
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(4));
  const items = screen.getAllByRole("listitem");
  fireEvent.dragStart(items[0]!);
  fireEvent.drop(items[3]!);
  await waitFor(() => expect(api.setSetting).toHaveBeenCalledWith("ui.photo.order.7", "[2,99,3,4,1]"));
  expect(screen.getAllByRole("listitem").map((item) => within(item).getByRole("button", { name: /检视照片/ }).getAttribute("aria-label")))
    .toEqual(["检视照片 · B.jpg", "检视照片 · C.jpg", "检视照片 · D.jpg", "检视照片 · A.jpg"]);
});

it("顺序保存失败不会静默，精选带立即显示危险提示", async () => {
  api.setSetting.mockRejectedValueOnce(new Error("disk full"));
  render(<PhotoFeaturedStrip />);
  await act(async () => resolveSettings({ "ui.photo.order.7": "[1,2]" }));
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
  fireEvent.click(screen.getByRole("button", { name: "后移 · one.jpg" }));
  await waitFor(() => expect(getToastSnapshot()).toMatchObject({
    text: expect.stringContaining("照片顺序未保存"),
    tone: "danger",
  }));
});
