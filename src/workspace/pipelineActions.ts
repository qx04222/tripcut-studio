import { arrangeSelectedSegments } from "../api";
import { OPEN_AUTO_SELECT_EVENT } from "./onboarding";
import { pipelineNextDisabled, type PipelineState, type PipelineStep } from "./pipelineModel";
import { refreshClipsFeed } from "./useClipsFeed";
import { dispatchWorkspace } from "./WorkspaceStore";

/** 把 DOM 焦点送进某一栏的 landmark(与 F6 同一条路)。 */
function focusPane(pane: "pool" | "band"): void {
  dispatchWorkspace({ type: "focus-pane", pane });
  document.querySelector<HTMLElement>(`[data-pane="${pane}"]`)?.focus();
}

/**
 * 导航条上点某一步 = 把界面焦点带到那一步(规格 §1 第一条):
 * ① 打开导入抽屉 / ② 聚焦媒体池 / ③ 聚焦镜头带 / ④ 打开导出抽屉。
 */
export function focusPipelineStep(step: PipelineStep): void {
  switch (step) {
    case 1:
      dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "source" });
      return;
    case 2:
      focusPane("pool");
      return;
    case 3:
      focusPane("band");
      return;
    case 4:
      dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
      return;
  }
}

/** 「一键排入」的结果广播:镜头带(车道 B)接它出 toast;壳这边只保证数据刷新。 */
export const PIPELINE_ARRANGED_EVENT = "tripcut:pipeline-arranged";

/** 第 ③ 步的主动作:把本集精选段一键排进镜头带,然后把焦点带过去。 */
export async function arrangeIntoBand(): Promise<{ placed: number; chapters: number }> {
  const outcome = await arrangeSelectedSegments();
  await refreshClipsFeed(true).catch(() => undefined);
  window.dispatchEvent(new CustomEvent(PIPELINE_ARRANGED_EVENT, { detail: outcome }));
  focusPane("band");
  return outcome;
}

/**
 * 顶栏「下一步:…」主按钮(规格 §1 第二条):
 * ① 导入素材 → 导入抽屉;② 自动挑选 → 镜头带的自动挑选面板;③ 排到镜头带 → 一键排入;
 * ④ 导出 / 再导出一次 → 导出抽屉。
 */
export function runPipelineNext(state: PipelineState): void {
  // R19 U-01:一条都还没分析完时按钮本来就是禁用的;键盘 / 程序路径进来也不发一个必然失败的挑选。
  if (pipelineNextDisabled(state)) return;
  if (state.complete) {
    dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
    return;
  }
  switch (state.step) {
    case 1:
      dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "source" });
      return;
    case 2:
      focusPane("pool");
      window.dispatchEvent(new CustomEvent(OPEN_AUTO_SELECT_EVENT));
      return;
    case 3:
      void arrangeIntoBand().catch(() => focusPane("band"));
      return;
    case 4:
      dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
      return;
  }
}
