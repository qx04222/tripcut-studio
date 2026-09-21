// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EMPTY_STATUS, summaryLine } from "./deliverModel";
import { QuickExportPanel } from "./QuickExportPanel";
import { PhotoExportFooter, PhotoExportPanel } from "./PhotoExportPanel";
import { PHOTO_EXPORT_EMPTY_TITLE, PHOTO_EXPORT_LABEL, isPhotoExportDone, photoDoneLine, type PhotoExport } from "./usePhotoExport";
import type { QuickExport } from "./useQuickExport";

afterEach(cleanup);

/** R21 照片线(业主拍板):视频交付 UI 不再提照片 —— 汇总只数视频段与整条收藏。 */
it("视频交付汇总只数视频,不再有「N 张」", () => {
  const status = { ...EMPTY_STATUS, selected_count: 10, selected_segment_count: 5, selected_whole_count: 5, selected_photo_count: 5 };
  expect(summaryLine(status)).toBe("10 项 · 5 段精选片段 · 5 条收藏的整条视频 · 预计 0:00");
  expect(summaryLine(status)).not.toContain("张");
});
it("旧照片阻止错误不再生成替代按钮", () => {
  const quick = { planError: 'photo_not_supported:本集含 5 张照片,视频文件导出暂不支持照片;请用「交给剪映」或「整包交付」', done: false, selection: null } as QuickExport;
  render(<QuickExportPanel quick={quick} status={{ ...EMPTY_STATUS, selected_count: 10 }} />);
  expect(screen.queryByText(/本集含 5 张照片/)).toBeNull();
  expect(screen.queryByRole("button", { name: "交给剪映" })).toBeNull();
  expect(screen.queryByRole("button", { name: "整包交付" })).toBeNull();
  expect(screen.getByText("第 ② 步还没做:先挑几段")).toBeTruthy();
});

it("整包「内容」节不再列照片行,也不再说「仅照片」", async () => {
  const { DeliverContents } = await import("./DeliverContents");
  render(<DeliverContents status={{ ...EMPTY_STATUS, selected_count: 5, selected_segment_count: 5, selected_photo_count: 5 }} includeContactSheet={true} useJianyingDraft={false} targetSeconds={null} />);
  expect(screen.queryByText(/含伴随文件/)).toBeNull();
  expect(screen.queryByText("仅照片 · 本次不生成")).toBeNull();
  expect(screen.getByText("1 条 · 完整 · 1080p 通用 MP4")).toBeTruthy();
  cleanup();
  render(<DeliverContents status={EMPTY_STATUS} includeContactSheet={true} useJianyingDraft={false} targetSeconds={null} />);
  expect(screen.getByText("暂无交付项 · 本次不生成")).toBeTruthy();
});

function photoExport(overrides: Partial<PhotoExport> = {}): PhotoExport {
  return {
    lastDir: "/Users/mock/Desktop", plan: { job_id: null, dir: "/Users/mock/Desktop/EP01_精选照片_2026-09-20", files: ["01_a.jpg", "02_b.jpg"], order_file: "顺序.txt" },
    planError: null, busy: false, error: null, canExport: true,
    exportNow: vi.fn(async () => undefined), changeFolder: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), done: false, reveal: vi.fn(async () => undefined),
    ...overrides,
  };
}

const PHOTO_FORBIDDEN = /剪映|镜头带|章节|秒|交付|素材包|整包|精选段|粗剪|镜头表/;

it("照片导出面板:清单按张数,只用照片的词", () => {
  render(<><PhotoExportPanel photos={photoExport()} status={{ ...EMPTY_STATUS, selected_count: 2, selected_photo_count: 2 }} /><PhotoExportFooter photos={photoExport()} status={{ ...EMPTY_STATUS, selected_count: 2, selected_photo_count: 2 }} onClose={() => undefined} /></>);
  expect(screen.getByRole("region", { name: PHOTO_EXPORT_LABEL })).toBeTruthy();
  expect(screen.getByText("2 张照片 · 附「顺序.txt」")).toBeTruthy();
  expect(screen.getByRole("list", { name: "将导出的照片" }).textContent).toContain("01_a.jpg");
  expect(screen.getByRole("button", { name: "导出精选照片到上次文件夹" })).toBeTruthy();
  expect(document.body.textContent ?? "").not.toMatch(PHOTO_FORBIDDEN);
});

it("照片导出面板:没有精选照片时给照片工作台自己的空态", () => {
  render(<PhotoExportPanel photos={photoExport({ plan: { job_id: null, dir: "", files: [], order_file: "顺序.txt" }, canExport: false })} status={EMPTY_STATUS} />);
  expect(screen.getByText(PHOTO_EXPORT_EMPTY_TITLE)).toBeTruthy();
  expect(document.body.textContent ?? "").not.toMatch(PHOTO_FORBIDDEN);
});

it("照片导出完成:按张数报,失败照张数点名", () => {
  const status = { ...EMPTY_STATUS, job_id: 4, status: "done" as const, stage: "complete" as const, mode: "photos" as const, selected_count: 3, selected_photo_count: 3, completed_items: 2, failed_items: 1,
    output_path: "/Users/mock/Desktop/EP01_精选照片_2026-09-20",
    items: [{ clip_id: 1, file_name: "a.jpg", output_name: "01_a.jpg", status: "done" as const, note: null, warning: false }, { clip_id: 2, file_name: "b.heic", output_name: "02_b.jpg", status: "failed" as const, note: "读不出来", warning: false }] };
  expect(isPhotoExportDone(status, 4)).toBe(true);
  expect(isPhotoExportDone({ ...status, mode: "kit" as const }, 4)).toBe(false);
  expect(photoDoneLine(status)).toBe("已导出 2 张照片 · 1 张没导出来");
  render(<PhotoExportPanel photos={photoExport({ done: true })} status={status} />);
  expect(screen.getByText("已导出 2 张照片 · 1 张没导出来")).toBeTruthy();
  expect(screen.getByRole("list", { name: "照片逐张状态" }).textContent).toContain("b.heic");
  expect(document.body.textContent ?? "").not.toMatch(PHOTO_FORBIDDEN);
});
