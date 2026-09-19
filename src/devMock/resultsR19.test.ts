// R19 results 车道:假后端上的「一句话 / 预设 → 挑选 → 结果面板 → 不要 / 换 / 全部撤销」全流程。
// 真后端的同一条链在 src-tauri/src/core/smart_select_runs.rs 的测试里;这里保证 devMock(preview:shots
// 与 e2e 用的那份)与 api.ts 的形状一致,新库 + 一批夹具从头走到尾。
import { beforeEach, describe, expect, it } from "vitest";

import type { AutoSelectOutcome, AutoSelectRunRow, AutoSelectRunView, ClipListItem, SelectSegment } from "../api";
import { __resetMockForTests, handleMockCommand } from "./fixture";

function segments(): SelectSegment[] {
  const clips = handleMockCommand("list_clips", {}) as ClipListItem[];
  return clips.flatMap((clip) => (clip.id === null ? [] : (handleMockCommand("list_select_segments", { clipId: clip.id }) as SelectSegment[])));
}

describe("devMock:自动挑选 → 结果面板全流程(R19 P-01 / P-03)", () => {
  beforeEach(() => __resetMockForTests());

  it("带参数挑一批:outcome 有 run_id;list_auto_select_run 行数 = created 数;每行 reason 非空且是中文", () => {
    const before = segments().length;
    const outcome = handleMockCommand("auto_select_episode_with", {
      budgetSecs: 60,
      scope: "all",
      weightsJson: JSON.stringify({ sharp: 0.3, motion: 0.1, exposure: 0.2, sound: 0.05, no_cut: 0.1, interest: 0.25 }),
      pick: "chapters",
      prompt: "挑 60 秒,风景为主,按时间顺序",
    }) as AutoSelectOutcome;
    expect(outcome.created.length).toBeGreaterThanOrEqual(1);
    expect(outcome.run_id).toBe(outcome.batch_id);
    expect(segments().length).toBe(before + outcome.created.length);
    const view = handleMockCommand("list_auto_select_run", { runId: outcome.run_id }) as AutoSelectRunView;
    expect(view.rows).toHaveLength(outcome.created.length);
    expect(view.params.prompt).toBe("挑 60 秒,风景为主,按时间顺序");
    expect(view.params.weights?.interest).toBe(0.25);
    for (const row of view.rows) {
      expect(row.reasons.length).toBeGreaterThan(0);
      expect(row.reasons.every((reason) => /[一-鿿]/.test(reason))).toBe(true);
      expect(row.secs).toBeGreaterThan(0);
    }
  });

  it("不要这一段 → 行消失、segments −1;换一段 → 行数不变、段换了素材;全部撤销 → 本批回 0", () => {
    const outcome = handleMockCommand("auto_select_episode", { budgetSecs: 60, scope: "all" }) as AutoSelectOutcome;
    const total = outcome.created.length;
    expect(total).toBeGreaterThanOrEqual(2);
    const before = segments().length;
    const view = handleMockCommand("list_auto_select_run", { runId: outcome.run_id }) as AutoSelectRunView;
    expect(view.rows).toHaveLength(total);

    handleMockCommand("delete_select_segment", { segmentId: outcome.created[0] });
    const afterDrop = handleMockCommand("list_auto_select_run", { runId: outcome.run_id }) as AutoSelectRunView;
    expect(afterDrop.rows).toHaveLength(total - 1);
    expect(segments().length).toBe(before - 1);

    const withSibling = afterDrop.rows.find((row) => row.siblings.length > 0);
    expect(withSibling, "假后端里至少一行有被去重掉的兄弟(截图要看得见「可展开」)").toBeTruthy();
    const replaced = handleMockCommand("replace_auto_segment", { segmentId: withSibling!.segment_id }) as AutoSelectRunRow;
    expect(replaced.clip_id).toBe(withSibling!.siblings[0]!.clip_id);
    const afterReplace = handleMockCommand("list_auto_select_run", { runId: outcome.run_id }) as AutoSelectRunView;
    expect(afterReplace.rows).toHaveLength(total - 1);
    expect(afterReplace.rows.some((row) => row.segment_id === replaced.segment_id)).toBe(true);
    expect(afterReplace.rows.some((row) => row.segment_id === withSibling!.segment_id)).toBe(false);

    const removed = handleMockCommand("undo_auto_select", { batchId: outcome.batch_id }) as number;
    expect(removed).toBe(total - 1);
    expect((handleMockCommand("list_auto_select_run", { runId: outcome.run_id }) as AutoSelectRunView).rows).toHaveLength(0);
    expect(segments().length).toBe(before - total);
  });
});
