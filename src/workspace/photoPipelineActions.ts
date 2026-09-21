import type { PhotoPipelineState, PhotoPipelineStep } from "./photoPipelineModel";
import { dispatchWorkspace } from "./WorkspaceStore";

/** 把 DOM 焦点送进照片网格(照片工作台里 `data-pane="pool"` 就是网格)。 */
function focusPhotoGrid(): void {
  dispatchWorkspace({ type: "focus-pane", pane: "pool" });
  document.querySelector<HTMLElement>('.photo-workspace [data-pane="pool"]')?.focus();
}

/**
 * R21 W3 P1-1:照片流水线的三步各自去哪 —— ① 导入抽屉 / ② 照片网格 / ③ 导出抽屉(只有「导出精选照片」)。
 * 没有「排到镜头带」「自动挑选面板」这两站。
 */
export function focusPhotoPipelineStep(step: PhotoPipelineStep): void {
  switch (step) {
    case 1:
      dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "source" });
      return;
    case 2:
      focusPhotoGrid();
      return;
    case 3:
      dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
      return;
  }
}

/** 顶栏「下一步:…」在照片工作台:① 导入照片 → 导入抽屉;② 挑选照片 → 网格(一句话挑照片的输入框);③ / 再导出一次 → 导出抽屉。 */
export function runPhotoPipelineNext(state: PhotoPipelineState): void {
  if (state.complete) {
    dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
    return;
  }
  if (state.step === 2) {
    focusPhotoGrid();
    document.querySelector<HTMLElement>(".photo-ws-auto input, .photo-ws-auto textarea")?.focus();
    return;
  }
  focusPhotoPipelineStep(state.step);
}
