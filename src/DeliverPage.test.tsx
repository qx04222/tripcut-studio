// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  cancelExport: vi.fn(),
  generateJianyingDraft: vi.fn(),
  getCurrentEpisode: vi.fn(),
  getExportStatus: vi.fn(),
  getJianyingAvailability: vi.fn(),
  listPlatformPresets: vi.fn(),
  pickExportFolder: vi.fn(),
  revealExport: vi.fn(),
  startExport: vi.fn(),
  // R10 U-20:useDeliverForm 读 / 写 ui.deliver.*(记住上次选择);旧页共用同一个 hook。
  getSettings: vi.fn(async () => ({})),
  setSetting: vi.fn(async () => undefined),
  // R10 U-05:useDeliverForm 现在还向后端预览画布;旧页不显示它,回 null 即可。
  previewExportCanvas: vi.fn(async () => null),
  startExportWithCanvas: vi.fn(),
}));
vi.mock("./api", () => apiMock);

import { DeliverPage, DeliverView } from "./DeliverPage";
import type { EpisodeSummary, ExportStatus, PlatformPreset } from "./api";

const idleStatus: ExportStatus = {
  job_id: null,
  status: "idle",
  stage: "idle",
  selected_count: 4,
  selected_segment_count: 3,
  selected_whole_count: 1,
  total_duration_seconds: 185,
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

/** 与 migration 0031 的种子数据保持一致——tb 统一 1/1_000_000。 */
const platformPresets: PlatformPreset[] = [
  {
    platform: "douyin",
    display_name: "抖音",
    portrait: [1080, 1920],
    landscape: [1920, 1080],
    duration_budget_ticks: 60_000_000,
    tb_num: 1,
    tb_den: 1_000_000,
    subtitle_style: {},
  },
  {
    platform: "xiaohongshu",
    display_name: "小红书",
    portrait: [1080, 1440],
    landscape: [1920, 1080],
    duration_budget_ticks: 90_000_000,
    tb_num: 1,
    tb_den: 1_000_000,
    subtitle_style: {},
  },
  {
    platform: "bilibili",
    display_name: "B站",
    portrait: [1080, 1920],
    landscape: [1920, 1080],
    duration_budget_ticks: 600_000_000,
    tb_num: 1,
    tb_den: 1_000_000,
    subtitle_style: {},
  },
  {
    platform: "moments",
    display_name: "朋友圈",
    portrait: [1080, 1920],
    landscape: [1920, 1080],
    duration_budget_ticks: 15_000_000,
    tb_num: 1,
    tb_den: 1_000_000,
    subtitle_style: {},
  },
  {
    platform: "family",
    display_name: "家庭纪录",
    portrait: [1080, 1920],
    landscape: [3840, 2160],
    duration_budget_ticks: 0,
    tb_num: 1,
    tb_den: 1_000_000,
    subtitle_style: {},
  },
  {
    platform: "general",
    display_name: "通用",
    portrait: [1080, 1920],
    landscape: [1920, 1080],
    duration_budget_ticks: 0,
    tb_num: 1,
    tb_den: 1_000_000,
    subtitle_style: {},
  },
];

const supportedJianying = {
  installed_version: "11.3.0",
  supported: true,
  reason: "剪映 11.3.0 已通过明文空草稿金丝雀，可生成实验草稿",
};

const nativeProps = {
  jianying: supportedJianying,
  nativeBusy: false,
  nativeResult: null,
  nativeNotice: null,
  onGenerateNative: () => undefined,
  episodePlatform: "general" as const,
  overridePlatform: "general" as const,
  onOverridePlatformChange: () => undefined,
  includeContactSheet: true,
  onIncludeContactSheetChange: () => undefined,
  targetSeconds: null,
  onTargetSecondsChange: () => undefined,
};

describe("stable delivery view", () => {
  it("shows segment and whole-clip delivery counts without calling every item a favorite", () => {
    const markup = renderToStaticMarkup(
      <DeliverView
        status={idleStatus}
        destination={null}
        busy={false}
        error={null}
        {...nativeProps}
        onGenerate={() => undefined}
        onCancel={() => undefined}
        onReveal={() => undefined}
      />,
    );

    expect(markup).toContain("4");
    expect(markup).toContain("3:05");
    expect(markup).toContain("3 段精选片段 · 1 条整条收藏");
    expect(markup).toContain("预计交付时长");
    expect(markup).not.toContain("条收藏素材");
    expect(markup).not.toContain("按整条素材计算");
    for (const label of ["精选片段", "参考粗剪", "镜头表 CSV", "交付说明"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("生成交付包");
  });

  it("renders per-item progress, red failure evidence, and cancellation", () => {
    const running: ExportStatus = {
      ...idleStatus,
      job_id: 42,
      status: "running",
      stage: "remuxing",
      completed_items: 1,
      failed_items: 1,
      items: [
        {
          clip_id: 1,
          file_name: "good.mov",
          output_name: "001_good.mp4",
          status: "done",
          note: null,
          warning: false,
        },
        {
          clip_id: 2,
          file_name: "broken.mov",
          output_name: "002_broken.mp4",
          status: "failed",
          note: "moov atom not found",
          warning: false,
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <DeliverView
        status={running}
        destination="/Volumes/DELIVERY"
        busy={false}
        error={null}
        {...nativeProps}
        onGenerate={() => undefined}
        onCancel={() => undefined}
        onReveal={() => undefined}
      />,
    );

    expect(markup).toContain("整理精选片段");
    expect(markup).toContain("good.mov");
    expect(markup).toContain("broken.mov");
    expect(markup).toContain("moov atom not found");
    expect(markup).toContain("取消");
    expect(markup).toContain("1 失败");
  });

  it("shows Finder reveal only after a completed package", () => {
    const done: ExportStatus = {
      ...idleStatus,
      job_id: 43,
      status: "done",
      stage: "complete",
      completed_items: 4,
      output_path: "/Volumes/DELIVERY/旅剪项目_剪映交付_2026-08-31",
    };
    const markup = renderToStaticMarkup(
      <DeliverView
        status={done}
        destination={null}
        busy={false}
        error={null}
        {...nativeProps}
        onGenerate={() => undefined}
        onCancel={() => undefined}
        onReveal={() => undefined}
      />,
    );

    expect(markup).toContain("交付完成");
    expect(markup).toContain("在访达中显示");
    expect(markup).toContain("width:100%");
  });

  it("enables the experimental native draft button only for the measured version", () => {
    const supported = renderToStaticMarkup(
      <DeliverView
        status={idleStatus}
        destination={null}
        busy={false}
        error={null}
        {...nativeProps}
        onGenerate={() => undefined}
        onCancel={() => undefined}
        onReveal={() => undefined}
      />,
    );
    const unsupported = renderToStaticMarkup(
      <DeliverView
        status={idleStatus}
        destination={null}
        busy={false}
        error={null}
        {...nativeProps}
        jianying={{
          installed_version: "11.4.0",
          supported: false,
          reason: "当前剪映 11.4.0 不在已验证白名单",
        }}
        onGenerate={() => undefined}
        onCancel={() => undefined}
        onReveal={() => undefined}
      />,
    );

    expect(supported).toContain("生成剪映草稿（实验）</button>");
    expect(unsupported).toContain("当前剪映 11.4.0 不在已验证白名单");
    expect(unsupported).toContain("disabled=\"\"");
  });

  it("shows successful draft handoff without claiming that Jianying was opened", () => {
    const markup = renderToStaticMarkup(
      <DeliverView
        status={idleStatus}
        destination={null}
        busy={false}
        error={null}
        {...nativeProps}
        nativeResult={{
          status: "created",
          output_path: "/Users/tester/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/旅剪项目",
          draft_name: "旅剪项目",
          jianying_version: "11.3.0",
          selected_count: 4,
          subtitle_count: 1,
          chapter_marks: 0,
          has_music: false,
          message: "草稿已生成；请回到剪映首页打开并核对",
        }}
        onGenerate={() => undefined}
        onCancel={() => undefined}
        onReveal={() => undefined}
      />,
    );

    expect(markup).toContain("草稿已生成；请回到剪映首页打开并核对");
    expect(markup).toContain("com.lveditor.draft/旅剪项目");
    expect(markup).not.toContain("已自动打开剪映");
  });
});

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
  target_platform: "xiaohongshu",
  canvas_orientation: "portrait",
};

describe("DeliverPage per-export platform override", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    apiMock.getCurrentEpisode.mockResolvedValue(episode);
    apiMock.listPlatformPresets.mockResolvedValue(platformPresets);
    apiMock.getJianyingAvailability.mockResolvedValue({
      installed_version: null,
      supported: false,
      reason: "未检测",
    });
    apiMock.getExportStatus.mockResolvedValue(idleStatus);
    apiMock.pickExportFolder.mockResolvedValue("/Volumes/DELIVERY");
    apiMock.startExport.mockResolvedValue(idleStatus);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("defaults the override select to the current episode's platform", async () => {
    await act(async () => {
      root.render(<DeliverPage />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const select = container.querySelector<HTMLSelectElement>('select');
    expect(select?.value).toBe("xiaohongshu");
  });

  it("passes overridePlatform to startExport only when it differs from the episode setting", async () => {
    await act(async () => {
      root.render(<DeliverPage />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const generateButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "生成交付包",
    );
    await act(async () => {
      generateButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMock.startExport).toHaveBeenLastCalledWith("/Volumes/DELIVERY", undefined, true, 60);

    const select = container.querySelector<HTMLSelectElement>('select');
    await act(async () => {
      if (select) {
        select.value = "bilibili";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    await act(async () => {
      generateButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMock.startExport).toHaveBeenLastCalledWith("/Volumes/DELIVERY", "bilibili", true, 60);
  });

  it("defaults the contact sheet checkbox to checked and includes it in the package preview", async () => {
    await act(async () => {
      root.render(<DeliverPage />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const checkbox = container.querySelector<HTMLInputElement>(
      'label[aria-label="联系表.pdf"] input[type="checkbox"]',
    );
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(true);
  });

  it("passes includeContactSheet=false to startExport once the checkbox is unchecked", async () => {
    await act(async () => {
      root.render(<DeliverPage />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const checkbox = container.querySelector<HTMLInputElement>(
      'label[aria-label="联系表.pdf"] input[type="checkbox"]',
    );
    await act(async () => {
      checkbox?.click();
    });
    expect(checkbox?.checked).toBe(false);

    const generateButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "生成交付包",
    );
    await act(async () => {
      generateButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMock.startExport).toHaveBeenLastCalledWith("/Volumes/DELIVERY", undefined, false, 60);
  });
});

describe("DeliverPage rough cut target duration", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    apiMock.listPlatformPresets.mockResolvedValue(platformPresets);
    apiMock.getJianyingAvailability.mockResolvedValue({
      installed_version: null,
      supported: false,
      reason: "未检测",
    });
    apiMock.getExportStatus.mockResolvedValue(idleStatus);
    apiMock.pickExportFolder.mockResolvedValue("/Volumes/DELIVERY");
    apiMock.startExport.mockResolvedValue(idleStatus);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function targetSelect(): HTMLSelectElement | null {
    return container.querySelector<HTMLSelectElement>('label[aria-label="参考粗剪时长"] select');
  }

  it('defaults to "完整" when the platform preset has no duration budget', async () => {
    apiMock.getCurrentEpisode.mockResolvedValue({ ...episode, target_platform: "general" });
    await act(async () => {
      root.render(<DeliverPage />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(targetSelect()?.value).toBe("full");
  });

  it("preselects the closest option at or below the episode platform's duration budget", async () => {
    // xiaohongshu 的种子预算是 90 秒；30/60/180 里不超过 90 的最大档是 60。
    apiMock.getCurrentEpisode.mockResolvedValue(episode);
    await act(async () => {
      root.render(<DeliverPage />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(targetSelect()?.value).toBe("60");
  });

  it("passes the chosen target seconds through to startExport", async () => {
    apiMock.getCurrentEpisode.mockResolvedValue(episode);
    await act(async () => {
      root.render(<DeliverPage />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const select = targetSelect();
    await act(async () => {
      if (select) {
        select.value = "180";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    const generateButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "生成交付包",
    );
    await act(async () => {
      generateButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMock.startExport).toHaveBeenLastCalledWith("/Volumes/DELIVERY", undefined, true, 180);
  });
});
