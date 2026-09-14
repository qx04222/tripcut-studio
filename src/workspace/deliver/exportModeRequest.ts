import { dispatchWorkspace } from "../WorkspaceStore";
import type { ExportMode } from "./quickExportModel";

/**
 * R13 §5:镜头带右上「导入剪映继续剪」→ 交付抽屉直接落在「剪映草稿」模式。
 * 与 `requestQuickExport` 同一套一次性交接:入口先记下模式再开抽屉,抽屉挂载时取走(取过即清)。
 */

let pendingMode: ExportMode | null = null;

export function openDeliverAs(mode: ExportMode): void {
  pendingMode = mode;
  dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
}

export function takePendingExportMode(): ExportMode | null {
  const taken = pendingMode;
  pendingMode = null;
  return taken;
}

export function __resetExportModeForTests(): void {
  pendingMode = null;
}
