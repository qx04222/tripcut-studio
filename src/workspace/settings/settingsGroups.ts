import type { SettingsSectionId } from "../../settingsSections";
import type { IconName } from "../ui/icons";

/**
 * R13 §2:设置分区改成剪映式的六块 ——「项目与缓存 / 快捷键 / 播放与导出 / 性能 / 工具与模型 / 关于」。
 * 每块顶部一句「这里管什么」;所有项一行一控件,**没有「高级…」折叠**(R12 原则:不藏)。
 * 九个旧分区(`SettingsSectionId`,旧壳与帮助主题仍按它索引)一个都不少,只是各自搬进一块。
 */
export type SettingsGroupId = "project" | "keymap" | "playback" | "performance" | "tools" | "about";

export interface SettingsGroup {
  id: SettingsGroupId;
  label: string;
  /** 左轨 tab 下的小字。 */
  description: string;
  /** 分区顶部那一句「这里管什么」。 */
  intro: string;
  icon: IconName;
  /** 打开分区就看到的全部段(按这个顺序排)。 */
  sections: readonly SettingsSectionId[];
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: "project",
    label: "项目与缓存",
    description: "缓存占用、清理与多设备时间",
    intro: "这里管素材相关的本机数据:缓存占了多大、要不要清掉重建,以及多台设备拍的素材怎么对齐时间。原片永远只读。",
    icon: "settings-cache",
    sections: ["cache", "timeline"],
  },
  {
    id: "keymap",
    label: "快捷键",
    description: "键位预设与逐个修改",
    intro: "这里管键盘怎么用:选一套你熟悉的软件的键位(默认剪映),或者逐个改。",
    icon: "settings-keymap",
    sections: ["keymap"],
  },
  {
    id: "playback",
    label: "播放与导出",
    description: "主题、开播位置、连播、导出文件夹",
    intro: "这里管看片与出片的习惯:界面明暗与缩放、选中素材从哪开始播、播完接不接着播、导出存到哪。",
    icon: "settings-appearance",
    sections: ["appearance"],
  },
  {
    id: "performance",
    label: "性能",
    description: "后台并发、预览小文件、内存档位",
    intro: "这里管后台跑多快、占多少:同时处理几条素材、要不要用预览小文件、内存档位。",
    icon: "settings-performance",
    sections: ["performance"],
  },
  {
    id: "tools",
    label: "工具与模型",
    description: "视频处理、转写、画面识别、云端补镜",
    intro: "这里管旅剪用到的组件与模型:视频处理、语音转写、画面分析与 AI、云端补镜。装好就不用再来。",
    icon: "settings-tools",
    sections: ["tools", "generation", "analysis"],
  },
  {
    id: "about",
    label: "关于",
    description: "版本、更新、日志、隐私",
    intro: "版本与更新、日志,以及哪些内容永远留在本机。",
    icon: "settings-about",
    sections: ["about", "privacy"],
  },
] as const;

/**
 * R19 P-05:「显示全部功能」关时设置只剩 项目 / 播放与导出 / 工具 / 关于(快捷键的键位预设、性能进开关后),
 * 工具里的「云端补镜」段与左轨直达也进开关后。`keep` = 程序直落(`openSettings(section)`)到的那一块 / 那一段照样在。
 * 不删代码:开关打开原样回来(showAllFeaturesR19.test 逐项证明)。
 */
const HIDDEN_GROUPS: ReadonlySet<SettingsGroupId> = new Set(["keymap", "performance"]);
const HIDDEN_SECTIONS: ReadonlySet<SettingsSectionId> = new Set(["generation"]);

export function visibleSettingsGroups(showAll: boolean, keep?: SettingsGroupId): readonly SettingsGroup[] {
  if (showAll) return SETTINGS_GROUPS;
  return SETTINGS_GROUPS.filter((group) => !HIDDEN_GROUPS.has(group.id) || group.id === keep);
}

export function visibleSettingsSections(group: SettingsGroup, showAll: boolean, keep?: SettingsSectionId | null): readonly SettingsSectionId[] {
  if (showAll) return group.sections;
  return group.sections.filter((section) => !HIDDEN_SECTIONS.has(section) || section === keep);
}

/** 旧分区 → 六块之一(`openSettings("analysis")` 落到「工具与模型」)。 */
export function groupForSection(section: SettingsSectionId): SettingsGroupId {
  const group = SETTINGS_GROUPS.find((candidate) => candidate.sections.includes(section));
  return group?.id ?? "playback";
}

/**
 * 冒烟锚点(design-system §6 冻结:设置 sheet 左轨常驻「隐私与诊断」「云端补镜」)。六分区之后
 * 它们仍不是 tab,以左轨底部的快捷入口常驻 —— 点一下直落对应分区并滚到那一段。
 */
export const SETTINGS_QUICK_LINKS: readonly { label: string; section: SettingsSectionId }[] = [
  { label: "云端补镜", section: "generation" },
  { label: "隐私与诊断", section: "privacy" },
];

/** R19 P-05:直达里指向被藏段的那条(云端补镜)也跟开关走。 */
export function visibleQuickLinks(showAll: boolean): readonly { label: string; section: SettingsSectionId }[] {
  return showAll ? SETTINGS_QUICK_LINKS : SETTINGS_QUICK_LINKS.filter((link) => !HIDDEN_SECTIONS.has(link.section));
}
