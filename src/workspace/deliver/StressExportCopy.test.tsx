// @vitest-environment jsdom
// R13 压测 Z-09 / Z-10:导出抽屉页脚的失败文案 —— 不再是「export failed: … (os error 13)」,有失败时不说「导完了」。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ExportStatus } from "../../api";
import { DeliverResultCard } from "./DeliverResultCard";
import { JianyingKitFooter } from "./JianyingKitPanel";
import { QuickExportFooter } from "./QuickExportPanel";
import { exportErrorLine } from "./quickExportModel";
import type { JianyingKit } from "./useJianyingKit";
import type { QuickExport } from "./useQuickExport";

const doneWithFailures: ExportStatus = {
  job_id: 42, status: "done", stage: "complete", selected_count: 9, selected_segment_count: 9, selected_whole_count: 0,
  total_duration_seconds: 65, completed_items: 3, failed_items: 6, items: [], output_path: "/Volumes/tiny/EP01_导出", error: null,
  mode: "quick",
  contact_sheet_glyph_fallbacks: null, contact_sheet_cover_failures: null, rough_cut_target_seconds: null,
  rough_cut_actual_ticks: null, rough_cut_actual_tb_num: null, rough_cut_actual_tb_den: null,
};

const quick = {
  error: null, busy: false, canExport: true, done: true, lastDir: "/Volumes/tiny",
  exportNow: async () => undefined, changeFolder: async () => undefined, cancel: async () => undefined,
} as unknown as QuickExport;

const kit = { ...quick } as unknown as JianyingKit;

afterEach(cleanup);

describe("exportErrorLine(Z-09)", () => {
  it("文件夹不可写:直接说换一个,不带 dest_unavailable / os error", () => {
    const raw = "export failed: dest_unavailable: 上次的文件夹现在用不了 (/Volumes/s6-ro) : Permission denied (os error 13)";
    const line = exportErrorLine(raw);
    expect(line).toBe("这个文件夹不能写入。点「更改文件夹…」换一个再导出。");
    expect(line).not.toMatch(/export failed|os error|dest_unavailable|Permission denied/);
  });
  it("空间不足:剥前缀,保留后端的中文原因", () => {
    expect(exportErrorLine("export failed: 目标磁盘空间不足:预计需要 112.8 MiB,当前可用 29.2 MiB"))
      .toBe("导出没成功:目标磁盘空间不足:预计需要 112.8 MiB,当前可用 29.2 MiB。再试一次");
  });
});

describe("导出页脚(Z-10:有失败时不说「导完了」)", () => {
  it("快速导出 3 成 6 败:页脚是 alert,写明几个没导出来和下一步", () => {
    render(<QuickExportFooter quick={quick} status={doneWithFailures} onClose={() => undefined} />);
    const line = screen.getByRole("alert");
    expect(line.textContent).toBe("已导出 3 个文件 · 6 个没导出来。点「只重试失败的」再导一次。");
    expect(line.textContent).not.toContain("导完了");
  });
  it("全部成功仍是「导完了」", () => {
    render(<QuickExportFooter quick={quick} status={{ ...doneWithFailures, completed_items: 9, failed_items: 0 }} onClose={() => undefined} />);
    expect(screen.getByRole("status").textContent).toContain("导完了");
  });
  it("素材包 3 成 6 败:页脚同样不说「导完了」", () => {
    render(<JianyingKitFooter kit={kit} status={{ ...doneWithFailures, mode: "kit" }} onClose={() => undefined} />);
    expect(screen.getByRole("alert").textContent).toBe("已导出 3 个片段 · 6 个没导出来。腾出空间或换个文件夹后再导一次。");
  });
});

describe("交付失败结果卡(Z-09,真机 2026-09-14)", () => {
  it("后端整包失败的原因不带 export failed 前缀", () => {
    render(<DeliverResultCard status={{ ...doneWithFailures, status: "failed", stage: "failed", error: "export failed: 所有精选片段均无法读取，未生成交付包" }} onReveal={() => undefined} />);
    expect(screen.getByRole("alert").textContent).toBe("所有精选片段均无法读取，未生成交付包");
  });
});
