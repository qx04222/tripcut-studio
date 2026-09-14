import { useState, type JSX } from "react";

import { resetProjectLibrary } from "../../api";
import { failureText } from "../errorText";
import { pinHome } from "../homeStore";
import { Button, Card, Icon, SectionHeader, showToast } from "../ui";
import { dispatchWorkspace } from "../WorkspaceStore";
import { useSettingsFormContext } from "./SettingsFormContext";
import { bytesLabel } from "./settingsModel";

/** 重置项目库要打的那两个字。 */
export const RESET_CONFIRM_WORD = "确认";

/**
 * R15:「项目与缓存」的两项危险操作,各一张卡、各一句「会发生什么」:
 * - 清理缓存并重新分析:只删可以再生成的文件,后台重新生成;素材 / 评分 / 片段都在。
 * - 重置项目库:整库清空回到刚安装的样子(留主题 / 快捷键 / 引导),要打「确认」两个字。
 * AX:button「清理缓存并重新分析」/「再点一次确认清理」;textbox「重置确认」;button「重置项目库」。
 */
export function CacheSection(): JSX.Element {
  const form = useSettingsFormContext();
  const { status, cacheConfirm, busy } = form;
  const [resetDraft, setResetDraft] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  const resetArmed = resetDraft.trim() === RESET_CONFIRM_WORD;

  const resetLibrary = async () => {
    if (!resetArmed || resetBusy) return;
    setResetBusy(true);
    setResetNotice(null);
    try {
      const result = await resetProjectLibrary();
      setResetDraft("");
      showToast(`项目库已重置:清掉 ${result.removed_clips} 条素材记录;已回到首页`, { tone: "success" });
      // 回首页、媒体池 / 镜头带按新的空集换范围、收起设置。
      window.dispatchEvent(new CustomEvent("tripcut:episode-changed", { detail: null }));
      pinHome(true);
      dispatchWorkspace({ type: "close-drawer" });
    } catch (error) {
      setResetNotice(failureText("重置项目库", error));
    } finally {
      setResetBusy(false);
    }
  };

  return (
    <>
      <SectionHeader title="缓存与重建" description="只管理可重建产物,不触碰原片、片段选择与评级。" />
      <div className="settings-sheet-meter" aria-label="缓存占用">
        <div><span>数据库记录</span><strong>{bytesLabel(status?.cache.database_bytes ?? 0)}</strong></div>
        <div><span>目录实测</span><strong>{bytesLabel(status?.cache.disk_bytes ?? 0)}</strong></div>
      </div>
      {/* Z-18:说清缓存里最大的一块是什么、大概多大,磁盘紧张时知道能不能清。 */}
      <p className="settings-sheet-note">
        预览用小文件(每条素材一份)占用通常不超过原片大小;清掉后需要时会自动重建,不影响原片。
      </p>
      <Card className="settings-sheet-danger" padding={4}>
        <div className="settings-sheet-danger-copy">
          <Icon name="settings-cache" size={20} />
          <div>
            <strong>清理缓存并重新分析</strong>
            <small>删掉封面、预览小文件这些可以再生成的文件,然后在后台重新生成;素材、评分和片段都会留着,原片不会被删。进度看底栏。</small>
          </div>
        </div>
        <Button
          tone="danger"
          variant={cacheConfirm ? "primary" : "secondary"}
          disabled={busy || resetBusy}
          onClick={() => void form.clearCache()}
        >
          {cacheConfirm ? "再点一次确认清理" : "清理缓存并重新分析"}
        </Button>
      </Card>
      <Card className="settings-sheet-danger settings-sheet-reset" padding={4}>
        <div className="settings-sheet-danger-copy">
          <Icon name="warning" size={20} />
          <div>
            <strong>重置项目库</strong>
            <small>把整个项目库清空,回到刚安装时的样子:素材记录、集、评分、片段、导入记录和缓存都会删掉;主题、快捷键和引导会留着,原片不会被删。会先保存一份数据库快照。</small>
          </div>
        </div>
        <div className="settings-reset-field">
          <label htmlFor="settings-reset-confirm">{`输入「${RESET_CONFIRM_WORD}」两个字才能重置`}</label>
          <input
            id="settings-reset-confirm"
            aria-label="重置确认"
            value={resetDraft}
            disabled={resetBusy}
            placeholder={RESET_CONFIRM_WORD}
            onChange={(event) => setResetDraft(event.target.value)}
          />
          <Button tone="danger" variant="primary" busy={resetBusy} disabled={!resetArmed || busy} onClick={() => void resetLibrary()}>
            重置项目库
          </Button>
        </div>
        {resetNotice ? (
          <p className="settings-sheet-note" role="status">
            {resetNotice}
          </p>
        ) : null}
      </Card>
    </>
  );
}
