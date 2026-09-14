import { useEffect, useState, type JSX } from "react";

import { getSettingsStatus } from "../api";
import { requiredToolsMissing } from "../toolchainSteps";
import { Button, Icon } from "./ui";
import { dispatchWorkspace } from "./WorkspaceStore";

/**
 * R12 §1:首启不再有工具链弹窗。只有 ffmpeg / ffprobe 这种**必需**组件缺失时,顶栏下出一条
 * 横幅「视频处理组件缺失 · 去安装」;检测中 / 检测失败 / 只缺可选组件都不出现。不是模态,
 * 不抢焦点,本次启动关掉就不再出现(下次启动仍缺就仍出现——这是事实,不是引导)。
 * AX:`region` 名「视频处理组件缺失」,按钮「去安装」(打开设置 → 工具与模型)、「关闭提示」。
 */
export function ToolchainBanner(): JSX.Element | null {
  const [missing, setMissing] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let active = true;
    getSettingsStatus()
      .then((status) => {
        if (active && status) setMissing(requiredToolsMissing(status));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  if (!missing || dismissed) return null;
  return (
    <div className="toolchain-banner" role="region" aria-label="视频处理组件缺失">
      <Icon name="warning" size={16} className="toolchain-banner-icon" />
      <p className="toolchain-banner-text">
        <strong>视频处理组件缺失</strong>
        <span>导入和导出都要靠它;装好后重新检测就行,素材不会上传。</span>
      </p>
      <Button
        variant="primary"
        size="sm"
        aria-haspopup="dialog"
        onClick={() => dispatchWorkspace({ type: "open-drawer", drawer: "settings", section: "tools" })}
      >
        去安装
      </Button>
      <Button variant="icon" icon="x" size="sm" aria-label="关闭提示" title="关闭提示" onClick={() => setDismissed(true)} />
    </div>
  );
}
