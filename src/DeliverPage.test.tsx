import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DeliverView } from "./DeliverPage";
import type { ExportStatus } from "./api";

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
};

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
