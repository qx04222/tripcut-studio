// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { EMPTY_STATUS, summaryLine } from "./deliverModel";
import { QuickExportPanel } from "./QuickExportPanel";
import { deliverCardPhotoSuffix } from "../DeliverDrawer";
import type { QuickExport } from "./useQuickExport";

afterEach(cleanup);
it("混合交付汇总分别数视频段与照片", () => {
  const status = { ...EMPTY_STATUS, selected_count: 10, selected_segment_count: 5, selected_photo_count: 5 };
  expect(summaryLine(status)).toContain("5 段 · 5 张");
});
it("旧照片阻止错误不再生成替代按钮", () => {
  const quick = { planError: 'photo_not_supported:本集含 5 张照片,视频文件导出暂不支持照片;请用「交给剪映」或「整包交付」', done: false, selection: null } as QuickExport;
  render(<QuickExportPanel quick={quick} status={{ ...EMPTY_STATUS, selected_count: 10 }} />);
  expect(screen.queryByText(/本集含 5 张照片/)).toBeNull();
  expect(screen.queryByRole("button", { name: "交给剪映" })).toBeNull();
  expect(screen.queryByRole("button", { name: "整包交付" })).toBeNull();
  expect(screen.getByText("第 ② 步还没做:先挑几段")).toBeTruthy();
});

it("三卡只有素材包和整包提示照片一起交付", () => {
  expect(deliverCardPhotoSuffix("quick", 5)).toBe("");
  expect(deliverCardPhotoSuffix("handoff", 5)).toBe(" · 5 张照片一起交付");
  expect(deliverCardPhotoSuffix("full", 5)).toBe(" · 5 张照片一起交付");
});

it("照片整包交付说明照片独立输出且参考粗剪只用视频", async () => {
  const { DeliverContents } = await import("./DeliverContents");
  render(<DeliverContents status={{ ...EMPTY_STATUS, selected_count: 10, selected_segment_count: 5, selected_photo_count: 5 }} includeContactSheet={true} useJianyingDraft={false} targetSeconds={null} />);
  expect(screen.getByText("5 张 · 含伴随文件")).toBeTruthy();
  expect(screen.getByText("1 条 · 完整 · 1080p 通用 MP4")).toBeTruthy();
  expect(screen.queryByText("含照片 · 本次不生成")).toBeNull();
});

it("纯照片整包不承诺不存在的视频参考粗剪", async () => {
  const { DeliverContents } = await import("./DeliverContents");
  render(<DeliverContents status={{ ...EMPTY_STATUS, selected_count: 5, selected_photo_count: 5 }} includeContactSheet={true} useJianyingDraft={false} targetSeconds={null} />);
  expect(screen.getByText("仅照片 · 本次不生成")).toBeTruthy();
  expect(screen.queryByText("1 条 · 完整 · 1080p 通用 MP4")).toBeNull();
});

it("空交付清单不把零素材误写成仅照片", async () => {
  const { DeliverContents } = await import("./DeliverContents");
  render(<DeliverContents status={EMPTY_STATUS} includeContactSheet={true} useJianyingDraft={false} targetSeconds={null} />);
  expect(screen.getByText("暂无交付项 · 本次不生成")).toBeTruthy();
  expect(screen.queryByText("仅照片 · 本次不生成")).toBeNull();
});
