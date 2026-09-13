import type { SettingsSectionId } from "../../settingsSections";
import type { IconName } from "../ui/icons";

/**
 * R11 简化专项 #2:设置页收成 3 个分区 + 每区一个「高级…」折叠。九个旧分区(`SettingsSectionId`,
 * 旧壳与帮助主题仍按它索引)一个都不少,只是分到三个组里:常用的直接摆出来,其余收进「高级…」。
 */
export type SettingsGroupId = "general" | "tools" | "about";

export interface SettingsGroup {
  id: SettingsGroupId;
  label: string;
  description: string;
  icon: IconName;
  /** 打开分区就看到的那几段。 */
  primary: readonly SettingsSectionId[];
  /** 收在「高级…」里的那几段(默认折叠;`openSettings(section)` 直落时自动展开)。 */
  advanced: readonly SettingsSectionId[];
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: "general",
    label: "常用",
    description: "外观、播放与导出文件夹",
    icon: "settings-appearance",
    primary: ["appearance"],
    advanced: ["performance", "timeline"],
  },
  {
    id: "tools",
    label: "工具与模型",
    description: "工具链、Whisper、Chinese-CLIP、云端补镜",
    icon: "settings-tools",
    primary: ["tools", "generation"],
    advanced: ["analysis"],
  },
  {
    id: "about",
    label: "关于",
    description: "版本、更新、日志与缓存",
    icon: "settings-about",
    primary: ["about", "cache"],
    advanced: ["privacy"],
  },
] as const;

/** 旧分区 → 新组(`openSettings("analysis")` 落到「工具与模型」并展开高级)。 */
export function groupForSection(section: SettingsSectionId): SettingsGroupId {
  const group = SETTINGS_GROUPS.find((candidate) => candidate.primary.includes(section) || candidate.advanced.includes(section));
  return group?.id ?? "general";
}

export function isAdvancedSection(section: SettingsSectionId): boolean {
  return SETTINGS_GROUPS.some((group) => group.advanced.includes(section));
}

/**
 * 冒烟锚点(design-system §6 冻结:设置 sheet 左轨常驻「隐私与诊断」「云端补镜」)。三分区之后
 * 它们不再是 tab,以左轨底部的快捷入口常驻 —— 点一下直落对应分区(高级项会自动展开)。
 */
export const SETTINGS_QUICK_LINKS: readonly { label: string; section: SettingsSectionId }[] = [
  { label: "云端补镜", section: "generation" },
  { label: "隐私与诊断", section: "privacy" },
];
