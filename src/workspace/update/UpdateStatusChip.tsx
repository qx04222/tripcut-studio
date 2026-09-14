import type { CSSProperties, JSX } from "react";

import { Button, Icon } from "../ui";
import { UPDATE_TOAST } from "./UpdateHost";
import { downloadStatusLabel } from "./updateModel";
import { runUpdateRestart, useUpdateState } from "./updateStore";

/**
 * R17 车道 B:状态条里的更新短语。下载中「正在下载更新 42%」(带同款进度底色,不可点);
 * 下载完但用户点了「稍后」/ 关掉了 toast 之后,状态条留一枚「更新已下载 · 重启完成更新」
 * 的链接,免得只剩下次启动才想得起来。其它阶段什么都不渲染。
 */
export function UpdateStatusChip(): JSX.Element | null {
  const state = useUpdateState();
  if (state.phase === "downloading") {
    const percent = state.total !== null && state.total > 0 ? Math.min(100, Math.floor((state.downloaded / state.total) * 100)) : 0;
    return (
      <span className="workspace-status-phrase update-r17-status" data-update-phase="downloading">
        <Icon name="deliver" size={12} />
        <span className="workspace-status-progress" aria-hidden="true" style={{ "--progress": `${percent}%` } as CSSProperties} />
        {downloadStatusLabel(state.downloaded, state.total)}
      </span>
    );
  }
  if (state.phase === "ready") {
    return (
      <Button
        variant="ghost"
        size="sm"
        icon="check"
        className="workspace-status-phrase link update-r17-status"
        data-update-phase="ready"
        onClick={() => void runUpdateRestart()}
      >
        {`更新已下载 · ${UPDATE_TOAST.restart}`}
      </Button>
    );
  }
  return null;
}
