import { describe, expect, it } from "vitest";

import { autoSelectToast, pendingAnalysisCount } from "./BandAutoSelect";
import { derivePipeline, pipelineNextDisabled, pipelineNextLabel, type PipelineInput } from "./pipelineModel";

const base: PipelineInput = { clipCount: 0, analysisPending: 0, segmentCount: 0, chapters: [], exportCount: 0 };

/** R19 U-01:分析中不吃闭门羹 —— 主按钮说清「先挑已分析的 x/N 条」,全 0 已分析时禁用并给进度 + 预计时间。 */
describe("R19 U-01:分析中的主按钮", () => {
  it("有已分析的素材:文案「先挑已分析的 x/N 条」,可点", () => {
    const state = derivePipeline({ ...base, clipCount: 27, analysisPending: 9 });
    expect(pipelineNextLabel(state)).toBe("先挑已分析的 18/27 条");
    expect(pipelineNextDisabled(state)).toBe(false);
  });

  it("一条都还没分析完:禁用,文案带 0/N 与预计时间(估不出时只有进度)", () => {
    const state = derivePipeline({ ...base, clipCount: 27, analysisPending: 27 });
    expect(pipelineNextDisabled(state)).toBe(true);
    expect(pipelineNextLabel(state)).toBe("等画面分析 0/27 条");
    expect(pipelineNextLabel(state, "30 秒")).toBe("等画面分析 0/27 条 · 约 30 秒");
  });

  it("分析完了照旧「下一步:自动挑选」;不在第 ② 步时分析中也不改文案", () => {
    expect(pipelineNextLabel(derivePipeline({ ...base, clipCount: 3 }))).toBe("下一步:自动挑选");
    const arranging = derivePipeline({ ...base, clipCount: 3, analysisPending: 1, segmentCount: 2 });
    expect(pipelineNextLabel(arranging)).toBe("下一步:排到镜头带");
    expect(pipelineNextDisabled(arranging)).toBe(false);
  });
});

describe("R19 U-01:先挑已分析部分后的 toast", () => {
  const outcome = { created: [1, 2, 3], total_secs: 20.2, chapters_covered: 2, batch_id: "auto-9" };
  it("还有素材在分析:toast 末尾说剩余数;分析完了不加这句", () => {
    expect(autoSelectToast({ ...outcome, pending_left: 9 })).toBe("已挑选 3 段 · 共 20 s · 覆盖 2 章 · 还有 9 条在分析,分析完可再挑一次");
    expect(autoSelectToast({ ...outcome, pending_left: 0 })).toBe("已挑选 3 段 · 共 20 s · 覆盖 2 章");
    expect(autoSelectToast(outcome)).toBe("已挑选 3 段 · 共 20 s · 覆盖 2 章");
  });
  it("pendingAnalysisCount 数 pending + running", () => {
    expect(pendingAnalysisCount([{ analysis_status: "pending" }, { analysis_status: "running" }, { analysis_status: "done" }, { analysis_status: "failed" }] as never)).toBe(2);
  });
});
