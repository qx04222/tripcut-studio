import { useEffect, type CSSProperties, type JSX } from "react";

import { startModelsHost, useModels } from "./modelStore";
import { Icon } from "./ui";
import { dispatchWorkspace } from "./WorkspaceStore";

/** 状态条那一句:「正在下载画面理解模型 42%」。 */
export function modelDownloadLabel(title: string, downloaded: number, total: number): string {
  const percent = total > 0 ? Math.min(100, Math.floor((downloaded / total) * 100)) : 0;
  return `正在下载${title} ${percent}%`;
}

/**
 * R19 P-06(models 车道):状态条里的模型下载进度一句(只在下载中渲染;其它时候什么都不画)。
 * 顺带是模型 store 的宿主:桥接后端进度事件、读一次清单、接首启气泡的「安装」——壳里只挂一次
 * (StatusStrip 只多这一行,结构不动)。点它打开 设置 › 工具与模型。
 */
export function ModelStatusPhrase(): JSX.Element | null {
  const { cards } = useModels();
  useEffect(() => {
    try {
      return startModelsHost();
    } catch {
      // 壳测试里手抄的 api 替身可能缺这几条命令;状态条不因此炸掉。
      return undefined;
    }
  }, []);
  const active = cards.find((card) => card.phase === "downloading");
  if (!active) return null;
  const percent = active.total > 0 ? Math.min(100, Math.floor((active.downloaded / active.total) * 100)) : 0;
  return (
    <button
      type="button"
      className="workspace-status-phrase link models-r19-status"
      data-model-phase="downloading"
      title="点开 设置 › 工具与模型 查看或取消"
      onClick={() => dispatchWorkspace({ type: "open-drawer", drawer: "settings", section: "tools" })}
    >
      <Icon name="deliver" size={12} />
      <span className="workspace-status-progress" aria-hidden="true" style={{ "--progress": `${percent}%` } as CSSProperties} />
      {modelDownloadLabel(active.title, active.downloaded, active.total)}
    </button>
  );
}
