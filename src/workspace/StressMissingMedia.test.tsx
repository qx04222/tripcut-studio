// R14 车道 stress · Z-07 / Z-08:原片不在原位 → 媒体池「缺失」角标;交付抽屉给一句原因 + 「去缺失素材页重新定位」,主按钮禁用。
// @vitest-environment jsdom
import { act } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMock);

import type { ClipListItem, EpisodeSummary, ExportStatus, KitExportOutcome } from "../api";
import { __resetExportModeForTests } from "./deliver/exportModeRequest";
import { MISSING_SOURCE_REASON, RELOCATE_MISSING_ACTION, missingSourcesLine } from "./deliver/MissingSourcesNotice";
import { __resetQuickExportForTests } from "./deliver/quickExportModel";
import { PoolCard } from "./PoolCard";
import { __resetToastsForTests } from "./ui/toastStore";
import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests, dispatchWorkspace, getWorkspaceSnapshot } from "./WorkspaceStore";

const episode: EpisodeSummary = {
  id: 5,
  title: "EP05",
  theme: "",
  episode_number: 5,
  status: "active",
  created_at: "2026-09-01T00:00:00Z",
  archived_at: null,
  clip_count: 4,
  favorite_count: 2,
  export_count: 0,
  target_platform: "general",
  canvas_orientation: "landscape",
};

const idleStatus: ExportStatus = {
  job_id: null,
  status: "idle",
  stage: "idle",
  selected_count: 1,
  selected_segment_count: 1,
  selected_whole_count: 0,
  total_duration_seconds: 4,
  completed_items: 0,
  failed_items: 0,
  items: [],
  output_path: null,
  error: null,
  contact_sheet_glyph_fallbacks: null,
  contact_sheet_cover_failures: null,
  rough_cut_target_seconds: null,
  rough_cut_actual_ticks: null,
  rough_cut_actual_tb_num: null,
  rough_cut_actual_tb_den: null,
};

const plan: KitExportOutcome = {
  job_id: null,
  dir: "/Users/me/Desktop/EP05_剪映素材包_2026-09-14",
  files: ["01_第 1 章_IMG_0830_早餐.mp4"],
  order_file: "顺序.txt",
  missing: ["IMG_0830_早餐.mov"],
};

const clip: ClipListItem = {
  id: 7,
  episode_id: 5,
  folder_label: null,
  cover_url: null,
  path: "/Volumes/CARD/IMG_0830_早餐.mov",
  file_name: "IMG_0830_早餐.mov",
  byte_size: 1,
  quick_hash: null,
  full_hash: null,
  tb_num: 1,
  tb_den: 1_000,
  duration_ticks: 30_000,
  fps_num: 30,
  fps_den: 1,
  is_vfr: false,
  codec: "h264",
  width: 1920,
  height: 1080,
  captured_at: null,
  status: "ready",
  error: null,
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

beforeEach(() => {
  vi.clearAllMocks();
  __resetWorkspaceForTests();
  __resetQuickExportForTests();
  __resetExportModeForTests();
  __resetToastsForTests();
  apiMock.getCurrentEpisode.mockResolvedValue(episode);
  apiMock.listPlatformPresets.mockResolvedValue([]);
  apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: "11.4.13189", supported: false, reason: "这个版本还没人工核对过" });
  apiMock.getExportStatus.mockResolvedValue(idleStatus);
  apiMock.getSettings.mockResolvedValue({ "ui.export.last_dir": "/Users/me/Desktop" });
  apiMock.planJianyingKit.mockResolvedValue(plan);
  apiMock.planQuickExport.mockResolvedValue({ job_id: null, dir: "", files: ["001_x.mp4"], skipped: [], missing: ["IMG_0830_早餐.mov"] });
  apiMock.pickExportFolder.mockResolvedValue(null);
});
afterEach(cleanup);

function renderCard(item: ClipListItem): HTMLElement {
  render(
    <div role="grid">
      <div role="row">
        <PoolCard clip={item} columnIndex={1} selected={false} isAnchor onSelect={() => undefined} inMultiSelection={false} />
      </div>
    </div>,
  );
  return screen.getByRole("gridcell");
}

describe("Z-07 媒体池「缺失」角标", () => {
  it("missing_since 有值 → 卡片带「缺失」角标;为空 / 旧后端缺省 → 没有", () => {
    const card = renderCard({ ...clip, missing_since: "2026-09-14T03:00:00Z" });
    expect(within(card).getByText("缺失")).toBeTruthy();
    cleanup();
    expect(within(renderCard({ ...clip, missing_since: null })).queryByText("缺失")).toBeNull();
    cleanup();
    expect(within(renderCard(clip)).queryByText("缺失")).toBeNull();
  });
});

describe("Z-07 / Z-08 交付抽屉的原片缺失通知", () => {
  it("文案:一句原因 + 文件名;超过 3 条写「等 n 条」;不出现内部词", () => {
    expect(missingSourcesLine(["A.mov"])).toBe(`${MISSING_SOURCE_REASON}:A.mov`);
    expect(missingSourcesLine(["A.mov", "B.mov", "C.mov", "D.mov", "E.mov"])).toBe(`${MISSING_SOURCE_REASON}:A.mov、B.mov、C.mov 等 5 条`);
    expect(MISSING_SOURCE_REASON).not.toMatch(/os error|stat|missing_since/i);
  });

  it("素材包清单里有缺失原片 → 通知 + 按钮「去缺失素材页重新定位」→ 打开导入抽屉缺失页;主按钮禁用、不调 exportJianyingKit", async () => {
    render(<WorkspaceShell />);
    await act(async () => {
      dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
      await Promise.resolve();
    });
    const dialog = await screen.findByRole("dialog", { name: "导出" });
    const notice = await within(dialog).findByRole("alert", { name: "原片缺失" });
    expect(notice.textContent).toContain(`${MISSING_SOURCE_REASON}:IMG_0830_早餐.mov`);
    const primary = within(dialog).getByRole("button", { name: "导出剪映素材包到上次文件夹" }) as HTMLButtonElement;
    await waitFor(() => expect(primary.disabled).toBe(true));
    primary.click();
    expect(apiMock.exportJianyingKit).not.toHaveBeenCalled();
    await act(async () => {
      within(notice).getByRole("button", { name: RELOCATE_MISSING_ACTION }).click();
      await Promise.resolve();
    });
    expect(getWorkspaceSnapshot().openDrawer).toBe("import");
    expect(getWorkspaceSnapshot().importTab).toBe("missing");
  });

  it("导出片段(快速导出)同样给通知并禁用主按钮", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: null, supported: false, reason: "" });
    render(<WorkspaceShell />);
    await act(async () => {
      dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
      await Promise.resolve();
    });
    const dialog = await screen.findByRole("dialog", { name: "导出" });
    await act(async () => {
      within(dialog).getByRole("button", { name: "导出片段" }).click();
      await Promise.resolve();
    });
    await within(dialog).findByRole("alert", { name: "原片缺失" });
    const primary = within(dialog).getByRole("button", { name: "导出到上次文件夹" }) as HTMLButtonElement;
    await waitFor(() => expect(primary.disabled).toBe(true));
  });
});
