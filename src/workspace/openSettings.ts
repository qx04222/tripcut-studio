import type { SettingsSectionId } from "../settingsSections";
import { dispatchWorkspace } from "./WorkspaceStore";

/**
 * 打开设置 sheet 并直接落到某个分区(R10 U-14 的「去设置」链接等入口用)。
 * 签名:`openSettings(section: SettingsSectionId): void`,section 取
 * `src/settingsSections.ts` 的分区 id(如 `"analysis"` = 分析与 AI,`"generation"` = 云端补镜)。
 * 与顶栏「设置」按钮走同一个 `open-drawer` action,只是多带一个 `section`;
 * sheet 挂载时读 `settingsSection` 作为初始分区,之后用户自己切分区不受影响。
 */
export function openSettings(section: SettingsSectionId): void {
  dispatchWorkspace({ type: "open-drawer", drawer: "settings", section });
}
