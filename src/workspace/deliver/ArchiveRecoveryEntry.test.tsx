// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ArchiveRecoveryEntry } from "./ArchiveRecoveryEntry";
const api = vi.hoisted(() => ({ listArchives: vi.fn(), resumeArchive: vi.fn(), undoArchive: vi.fn() }));
vi.mock("./archiveApi", () => api);
afterEach(cleanup);
// R21 W3 P1-2 起入口按工作台分类(视频 = 素材包 / 整包,照片 = photo);通用行为用素材包记录测,照片记录见文末。
const partial = { id: "op", kind: "kit", status: "partial", destination: "/test/export", job_id: 1, needs_preparation: false, errors: ["磁盘不可用"] };
beforeEach(() => { vi.resetAllMocks(); api.listArchives.mockResolvedValue([partial]); });
it("shows one unfinished entry, preserves errors on failed recovery, and permits retry", async () => {
  api.resumeArchive.mockRejectedValueOnce(new Error("磁盘仍不可用"));
  render(<ArchiveRecoveryEntry />);
  fireEvent.click(await screen.findByText(/上次交付未完成/));
  fireEvent.click(screen.getByRole("button", { name: "继续交付" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "磁盘仍不可用");
  expect(screen.getByText("磁盘不可用")).toBeTruthy();
  expect(api.resumeArchive).toHaveBeenCalledWith("op");
});
it("does not report queued or partial recovery as completed", async () => {
  api.resumeArchive.mockResolvedValue(partial);
  render(<ArchiveRecoveryEntry />);
  fireEvent.click(await screen.findByText(/上次交付未完成/));
  fireEvent.click(screen.getByRole("button", { name: "继续交付" }));
  await waitFor(() => expect(api.listArchives).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("交付已完成")).toBeNull();
});
it("undo explicitly explains edited files will be kept and shows returned conflicts", async () => {
  api.undoArchive.mockResolvedValue({ ...partial, errors: ["已修改，保留"] });
  api.listArchives.mockResolvedValueOnce([{ ...partial, status: "done", errors: [] }]).mockResolvedValue([{ ...partial, errors: ["已修改，保留"] }]);
  render(<ArchiveRecoveryEntry />);
  fireEvent.click(await screen.findByText("交付记录与撤销"));
  expect(screen.getByText(/只撤销本次创建且未修改的文件/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "撤销复制" }));
  expect(await screen.findByText("已修改，保留")).toBeTruthy();
  expect(api.undoArchive).toHaveBeenCalledWith("op");
});

// R21 W3 验收 P1-2:照片工作台里这个入口说「导出」不说「交付」,而且只列 kind=photo 的记录;视频侧仍「交付」、只列素材包 / 整包。
const videoPartial = { ...partial, id: "kit-op", destination: "/test/kit" };
const photoPartial = { ...partial, kind: "photo" };
it("照片工作台:文案「上次导出未完成 · 继续导出 / 导出已完成 / 导出记录与撤销」,只列照片记录", async () => {
  api.listArchives.mockResolvedValue([photoPartial, videoPartial]);
  render(<ArchiveRecoveryEntry variant="photo" />);
  fireEvent.click(await screen.findByText(/上次导出未完成/));
  expect(screen.getByRole("button", { name: "继续导出" })).toBeTruthy();
  expect(screen.getByText("导出尚未完成")).toBeTruthy();
  expect(screen.queryByText("/test/kit")).toBeNull();
  expect(document.body.textContent).not.toMatch(/交付/);
  api.listArchives.mockResolvedValue([{ ...photoPartial, status: "done", errors: [] }, videoPartial]);
  cleanup();
  render(<ArchiveRecoveryEntry variant="photo" />);
  fireEvent.click(await screen.findByText("导出记录与撤销"));
  expect(screen.getByText("导出已完成")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/交付/);
});
it("视频工作台(默认):仍是「上次交付未完成 · 继续交付」,只列素材包 / 整包记录", async () => {
  api.listArchives.mockResolvedValue([photoPartial, videoPartial]);
  render(<ArchiveRecoveryEntry />);
  fireEvent.click(await screen.findByText(/上次交付未完成/));
  expect(screen.getByRole("button", { name: "继续交付" })).toBeTruthy();
  expect(screen.getByText("/test/kit")).toBeTruthy();
  expect(screen.queryByText("/test/export")).toBeNull();
});
