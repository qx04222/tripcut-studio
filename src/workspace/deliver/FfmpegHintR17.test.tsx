// @vitest-environment jsdom
// R17 车道 exportfix ⑤:失败行的 note 说明是 ffmpeg 不认编码器 / 选项时,结果卡多一行白话建议
// (去哪儿看用的是哪一份、清空自定义路径就用自带的);别的失败原因不出现这句。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ExportStatus } from "../../api";
import { DeliverResultCard } from "./DeliverResultCard";
import { FFMPEG_TOOL_HINT, ffmpegToolHint } from "./deliverModel";

const base: ExportStatus = {
  job_id: 7, status: "failed", stage: "failed", selected_count: 11, selected_segment_count: 11, selected_whole_count: 0,
  total_duration_seconds: 65, completed_items: 0, failed_items: 11, items: [], output_path: null,
  error: "所有精选片段均无法读取，未生成交付包",
  mode: "kit",
  contact_sheet_glyph_fallbacks: null, contact_sheet_cover_failures: null, rough_cut_target_seconds: null,
  rough_cut_actual_ticks: null, rough_cut_actual_tb_num: null, rough_cut_actual_tb_den: null,
};

afterEach(cleanup);

describe("ffmpegToolHint", () => {
  it("只认 Unrecognized option / Unknown encoder 两种 note", () => {
    expect(ffmpegToolHint("精选段帧精确转码失败（退出码 8，ffmpeg 6.0 (…/bin/ffmpeg)）：Unrecognized option 'allow_sw'. Error splitting the argument list: Option not found")).toBe(FFMPEG_TOOL_HINT);
    expect(ffmpegToolHint("参考粗剪 VideoToolbox 转码失败：Unknown encoder 'h264_videotoolbox'")).toBe(FFMPEG_TOOL_HINT);
    expect(ffmpegToolHint("这段的起止点和视频帧对不上（入点差 2 帧，出点差 5 帧）")).toBeNull();
    expect(ffmpegToolHint(null)).toBeNull();
    expect(FFMPEG_TOOL_HINT).toContain("设置 › 工具与模型");
    expect(FFMPEG_TOOL_HINT).toContain("清空自定义路径");
  });
});

describe("DeliverResultCard(交付失败时的 ffmpeg 建议行)", () => {
  it("note 含 Unrecognized option:结果卡出现一行建议,且只出现一次", () => {
    const items = [1, 2].map((n) => ({
      clip_id: n, file_name: `dji_${n}.MP4`, output_name: `0${n}_未分章_dji_${n}.mp4`, status: "failed" as const, warning: false,
      note: "精选段帧精确转码失败（退出码 8，ffmpeg 6.0 (…/bin/ffmpeg)）：Unrecognized option 'allow_sw'. Error splitting the argument list: Option not found",
    }));
    render(<DeliverResultCard status={{ ...base, items }} onReveal={() => undefined} />);
    expect(screen.getAllByText(FFMPEG_TOOL_HINT)).toHaveLength(1);
  });
  it("别的失败原因:没有这行", () => {
    const items = [{ clip_id: 1, file_name: "a.MP4", output_name: "01_a.mp4", status: "failed" as const, warning: false, note: "目标磁盘空间不足" }];
    render(<DeliverResultCard status={{ ...base, items }} onReveal={() => undefined} />);
    expect(screen.queryByText(FFMPEG_TOOL_HINT)).toBeNull();
  });
  it("导完但有失败项(done 卡)同样给建议", () => {
    const items = [{ clip_id: 1, file_name: "a.MP4", output_name: "01_a.mp4", status: "failed" as const, warning: false, note: "x：Unknown encoder 'h264_videotoolbox'" }];
    render(<DeliverResultCard status={{ ...base, status: "done", stage: "complete", completed_items: 10, failed_items: 1, output_path: "/tmp/EP01_剪映素材包", items }} onReveal={() => undefined} />);
    expect(screen.getAllByText(FFMPEG_TOOL_HINT)).toHaveLength(1);
  });
});
