import type { JSX } from "react";

import { Button } from "../ui";
import { UPDATE_TOAST } from "./UpdateHost";
import { downloadStatusLabel } from "./updateModel";
import { runUpdateDownload, runUpdateRestart, useUpdateState } from "./updateStore";

export const UPDATE_TOP_CHIP = {
  available: (version: string) => `新版本 ${version}`,
  availableTitle: "有新版本,点一下开始更新",
  downloading: "正在下载更新",
  ready: UPDATE_TOAST.restart,
  readyTitle: "更新已下载,重启就完成",
} as const;

/**
 * 业主(2026-09-14 晚):「顶部最右端、设置旁边增加新版本提醒,点击更新」。
 * 只在三种阶段露出:发现新版本(点击开始下载)/ 下载中(进度,不可点)/ 已下载(点击重启完成)。
 * 其余阶段不渲染,顶栏平时不多一个字。状态条底部的 `UpdateStatusChip` 仍在,两处同一份状态。
 */
export function UpdateTopChip(): JSX.Element | null {
  const state = useUpdateState();
  if (state.phase === "available" && state.version) {
    return (
      <Button
        variant="ghost"
        size="sm"
        icon="deliver"
        className="update-r17-topchip"
        data-update-phase="available"
        aria-label={UPDATE_TOP_CHIP.available(state.version)}
        title={UPDATE_TOP_CHIP.availableTitle}
        onClick={() => void runUpdateDownload()}
      >
        {UPDATE_TOP_CHIP.available(state.version)}
      </Button>
    );
  }
  if (state.phase === "downloading") {
    return (
      <span className="update-r17-topchip update-r17-topchip--busy" data-update-phase="downloading" role="status">
        {downloadStatusLabel(state.downloaded, state.total)}
      </span>
    );
  }
  if (state.phase === "ready") {
    return (
      <Button
        variant="primary"
        size="sm"
        icon="check"
        className="update-r17-topchip"
        data-update-phase="ready"
        aria-label={UPDATE_TOP_CHIP.ready}
        title={UPDATE_TOP_CHIP.readyTitle}
        onClick={() => void runUpdateRestart()}
      >
        {UPDATE_TOP_CHIP.ready}
      </Button>
    );
  }
  return null;
}
