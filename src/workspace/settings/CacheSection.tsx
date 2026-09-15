import { useState, type JSX } from "react";

import { CACHE_AUTO_CLEAN_DAYS_KEY, CACHE_CUSTOM_DIR_KEY, pickCacheFolder, relocateCacheDir, resetProjectLibrary } from "../../api";
import { failureText } from "../errorText";
import { pinHome } from "../homeStore";
import { Button, Card, Icon, SectionHeader, Select, showToast } from "../ui";
import { dispatchWorkspace } from "../WorkspaceStore";
import { SettingsRow } from "./SettingsControls";
import { useSettingsFormContext } from "./SettingsFormContext";
import { bytesLabel } from "./settingsModel";

/** 重置项目库要打的那两个字。 */
export const RESET_CONFIRM_WORD = "确认";

/** R18 F5/F6:缓存位置与自动清理的文案(AX 名冻结)。 */
export const CACHE_LOCATION = {
  title: "缓存位置",
  change: "更改缓存位置…",
  autoClean: "多久没用就自动清掉",
} as const;

/** F6 的天数档,与 Rust `CACHE_AUTO_CLEAN_DAY_CHOICES` 同一份;"0" = 从不(默认)。 */
export const AUTO_CLEAN_CHOICES: ReadonlyArray<readonly [value: string, label: string]> = [
  ["0", "从不(默认)"],
  ["15", "15 天前的"],
  ["30", "30 天前的"],
  ["60", "60 天前的"],
  ["90", "90 天前的"],
];

/** 没搬过(空串)时说人话,不要给用户看一个空白。 */
export function cacheLocationLabel(customDir: string | undefined): string {
  const trimmed = (customDir ?? "").trim();
  return trimmed === "" ? "应用内置位置(跟着素材库走)" : trimmed;
}

/**
 * R15:「项目与缓存」的两项危险操作,各一张卡、各一句「会发生什么」:
 * - 清理缓存并重新分析:只删可以再生成的文件,后台重新生成;素材 / 评分 / 片段都在。
 * - 重置项目库:整库清空回到刚安装的样子(留主题 / 快捷键 / 引导),要打「确认」两个字。
 * AX:button「清理缓存并重新分析」/「再点一次确认清理」;textbox「重置确认」;button「重置项目库」。
 */
export function CacheSection(): JSX.Element {
  const form = useSettingsFormContext();
  const { settings, status, cacheConfirm, busy } = form;
  const [relocating, setRelocating] = useState(false);
  const [resetDraft, setResetDraft] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  const resetArmed = resetDraft.trim() === RESET_CONFIRM_WORD;

  /**
   * F5:先选文件夹,再整体搬。搬成功后**后端会重启应用**,所以这个 await 不会回来——
   * 界面就留在「正在搬…」上,不做任何收尾。失败时把后端那句「现在怎么办」原样摆出来。
   */
  const relocate = async () => {
    if (relocating) return;
    const folder = await pickCacheFolder().catch(() => null);
    if (!folder) return;
    setRelocating(true);
    try {
      await relocateCacheDir(folder);
      showToast("缓存已搬好,正在重启让新位置生效…", { tone: "success" });
    } catch (error) {
      setRelocating(false);
      showToast(failureText(CACHE_LOCATION.change, error), { tone: "danger" });
    }
  };

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
      <div className="settings-sheet-group">
        {/* R18 F5:缓存可以搬到外接盘 —— 8 GB 内置盘的机器最需要这一条。 */}
        <SettingsRow
          title={CACHE_LOCATION.title}
          help="预览小文件和封面放在哪里。放到外接盘可以省内置盘;盘没插的时候会自动退回内置位置,重新生成一遍,不会丢素材。"
          className="settings-sheet-row--stack"
        >
          <div className="settings-sheet-cache-location">
            <code>{cacheLocationLabel(settings[CACHE_CUSTOM_DIR_KEY])}</code>
            <Button size="sm" busy={relocating} disabled={busy || relocating} onClick={() => void relocate()}>
              {CACHE_LOCATION.change}
            </Button>
          </div>
        </SettingsRow>
        {/* R18 F6:长期不用的缓存自己清掉,默认「从不」——不改变现状,想省盘的人自己开。 */}
        <SettingsRow
          title={CACHE_LOCATION.autoClean}
          help="一直没再看过的预览小文件,超过这个天数就自动清掉;需要时会重新生成。"
          htmlFor="settings-cache-auto-clean"
        >
          <Select
            id="settings-cache-auto-clean"
            aria-label={CACHE_LOCATION.autoClean}
            value={settings[CACHE_AUTO_CLEAN_DAYS_KEY] ?? "0"}
            disabled={busy}
            onChange={(event) => void form.save(CACHE_AUTO_CLEAN_DAYS_KEY, event.currentTarget.value)}
          >
            {AUTO_CLEAN_CHOICES.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </Select>
        </SettingsRow>
      </div>
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
