import type { JSX } from "react";

import { useGlobalDrop } from "./useGlobalDrop";
import { useWorkspace, type WorkspaceState } from "./WorkspaceStore";

/**
 * R18 M-06①:窗口任意位置都能接素材。拖到哪儿都行——整窗盖一层「松开即导入」,
 * 不用先把导入抽屉翻出来。
 *
 * 导入抽屉开着的时候这层不渲染:抽屉里已经有一层同样的提示,叠两层会出现
 * 两个同名 `status`,读屏会念两遍(业主记忆「探针别信无障碍快照」那一条的反面教训)。
 */
export function GlobalDropOverlay(): JSX.Element | null {
  const importDrawerOpen = useWorkspace((state: WorkspaceState) => state.openDrawer === "import");
  const active = useGlobalDrop();
  if (!active || importDrawerOpen) return null;
  return (
    <div className="global-drop" role="status" aria-label="拖放导入">
      <div className="global-drop-card">
        <strong>松开即导入</strong>
        <span>视频或整个文件夹都行</span>
      </div>
    </div>
  );
}
