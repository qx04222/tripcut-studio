import type { SettingsSectionId } from "./settingsSections";
import { formatKey, type KeymapAction, type KeymapTable } from "./workspace/keymap";

export interface KeyboardShortcut {
  id: string;
  /** 静态键帽(没有 `actions` 时照抄;有 `actions` 时只是剪映预设下的样子,真键从键位表取)。 */
  keys: readonly string[];
  action: string;
  detail: string;
  /** R13 §1:这一行对应键位表里的哪些动作 —— 帮助页随预设 / 自定义变化,不手抄。 */
  actions?: readonly KeymapAction[];
}

/** 一行帮助的键帽:有 `actions` 就按当前键位表取(每把键一颗键帽),否则用静态 `keys`。 */
export function shortcutKeys(shortcut: KeyboardShortcut, table: KeymapTable): readonly string[] {
  if (!shortcut.actions) return shortcut.keys;
  const keys = shortcut.actions.flatMap((action) => (table[action] ?? []).slice(0, 1).map(formatKey));
  return keys.length > 0 ? keys : shortcut.keys;
}

export interface KeyboardShortcutGroup {
  id: string;
  label: string;
  eyebrow: string;
  shortcuts: readonly KeyboardShortcut[];
}

/**
 * 新壳(导演台工作区)的全局键位 —— 规格 §3.2。这一组必须排在最前:用户抬头
 * 看帮助,第一眼要的是"整块界面怎么走",而不是某一栏内部的单键。
 */
export const WORKSPACE_SHORTCUTS: readonly KeyboardShortcut[] = [
  { id: "command-palette", keys: ["⌘", "K"], action: "命令面板", detail: "跳转、全量搜索、素材直达", actions: ["command-palette"] },
  { id: "cycle-pane", keys: ["F6"], action: "轮转栏焦点", detail: "媒体池 → 预览监视器 → 镜头带 → 检查器；⇧F6 反向，折叠起来的栏跳过", actions: ["cycle-pane"] },
  { id: "toggle-pool", keys: ["⌘", "1"], action: "折叠媒体池", detail: "收成 44px 竖条，再按一次展开", actions: ["toggle-pool"] },
  { id: "toggle-inspector", keys: ["⌘", "2"], action: "折叠检查器", detail: "收成 44px 竖条，再按一次展开", actions: ["toggle-inspector"] },
  { id: "immersive", keys: ["⌘", "⏎"], action: "沉浸预览", detail: "监视器铺满窗口，再按一次退出", actions: ["fullscreen"] },
  { id: "open-import", keys: ["⌘", "I"], action: "导入素材", detail: "打开导入抽屉的「来源」分页；光标在输入框里时不触发", actions: ["import"] },
  { id: "open-settings", keys: ["⌘", ","], action: "打开设置", detail: "设置以 sheet 形式下沉，不离开工作区", actions: ["settings"] },
  { id: "open-help", keys: ["?"], action: "打开本帮助", detail: "光标在输入框里时不触发", actions: ["help"] },
  { id: "escape", keys: ["Esc"], action: "退出当前层", detail: "抽屉 → 设置 sheet → 沉浸 → 清空搜索词，一次只退一层", actions: ["escape"] },
] as const;

export const SELECTION_SHORTCUTS: readonly KeyboardShortcut[] = [
  { id: "favorite", keys: ["F"], action: "收藏", detail: "把当前素材标为保留", actions: ["favorite"] },
  { id: "reject", keys: ["X"], action: "拒绝", detail: "把当前素材标为不采用", actions: ["reject"] },
  { id: "stars", keys: ["1–5"], action: "星级", detail: "为当前素材设置一至五星" },
  { id: "clear-rating", keys: ["0"], action: "清除评级", detail: "同时清除收藏、拒绝与星级", actions: ["clear-rating"] },
  { id: "expand-stack", keys: ["Tab"], action: "展开同一镜头的多条", detail: "展开或收起当前镜头的多条候选;信息与人物类镜头始终保留候选", actions: ["expand-stack"] },
  { id: "browse-stack", keys: ["↑", "↓"], action: "切换候选", detail: "在已展开的多条里移动当前候选,不立即改写首选", actions: ["prev-take", "next-take"] },
  { id: "replace-stack", keys: ["Enter"], action: "替换首选", detail: "把当前候选定为这组的首选", actions: ["promote-hero"] },
  { id: "lock-stack", keys: ["L"], action: "锁定候选", detail: "锁定或恢复当前候选", actions: ["lock-stack"] },
  { id: "reject-stack", keys: ["R"], action: "排除候选", detail: "永久排除候选但不删除素材", actions: ["reject-stack"] },
  { id: "immersive-player", keys: ["Space", "K"], action: "播放 / 暂停", detail: "焦点在卡片上也能停下或继续预览", actions: ["play-pause", "shuttle-pause"] },
] as const;

export const PLAYER_SHORTCUTS: readonly KeyboardShortcut[] = [
  { id: "step-back-second", keys: ["J"], action: "回退一秒", detail: "暂停并向前回看一秒", actions: ["shuttle-back"] },
  { id: "pause", keys: ["K"], action: "暂停", detail: "暂停当前播放", actions: ["shuttle-pause"] },
  { id: "play", keys: ["L"], action: "播放", detail: "继续播放当前素材", actions: ["shuttle-forward"] },
  { id: "step-frame", keys: ["←", "→"], action: "逐帧", detail: "向前或向后移动一帧", actions: ["frame-back", "frame-forward"] },
  { id: "mark-range", keys: ["I", "O"], action: "设置入出点", detail: "标记一个精选片段的边界", actions: ["mark-in", "mark-out"] },
  { id: "save-range", keys: ["S"], action: "保存精选段", detail: "保存当前完整的入出点", actions: ["save-range"] },
  { id: "toggle-playback", keys: ["Space"], action: "播放 / 暂停", detail: "切换当前播放状态", actions: ["play-pause"] },
  { id: "exit-player", keys: ["Esc"], action: "返回筛片", detail: "关闭沉浸播放器", actions: ["escape"] },
] as const;

export const KEYBOARD_SHORTCUT_GROUPS: readonly KeyboardShortcutGroup[] = [
  {
    id: "workspace",
    label: "工作区",
    eyebrow: "全局",
    shortcuts: WORKSPACE_SHORTCUTS,
  },
  {
    id: "selection",
    label: "媒体池",
    eyebrow: "选片",
    shortcuts: SELECTION_SHORTCUTS,
  },
  {
    id: "player",
    label: "预览监视器",
    eyebrow: "播放",
    shortcuts: PLAYER_SHORTCUTS,
  },
] as const;

/**
 * 一屏三栏的说明(规格 §1)。0.3.0 之前这里是"导入 → 筛片 → 打点 → 故事 → 交付"
 * 五个**页面**;新壳没有页面了,这五条改成"这一屏上的五个地方各管什么",
 * `number` 仍然保留,因为帮助浮层拿它当序号画。
 */
export const WORKFLOW_STEPS = [
  {
    id: "topbar",
    number: "01",
    label: "顶栏",
    eyebrow: "进出口",
    description: "导入素材、切换集、四步流水线导航、「下一步」、设置 —— 进出工作区的全部入口,当前在第几步一眼可见。",
  },
  {
    id: "pool",
    number: "02",
    label: "媒体池",
    eyebrow: "找素材",
    description: "左栏。搜索、筛选、缩略图网格;点一张卡片,监视器与检查器跟着换。",
  },
  {
    id: "monitor",
    number: "03",
    label: "预览监视器",
    eyebrow: "看画面",
    description: "中栏上半。播放、逐帧、I/O 打点与保存片段;⌘⏎ 铺满窗口。",
  },
  {
    id: "band",
    number: "04",
    label: "镜头带",
    eyebrow: "排顺序",
    description: "中栏下半。按章节分组拖排,空槽位点「生成候选」;下面那排分段切音乐 / 旅程 / 地点卡 / 模板。",
  },
  {
    id: "inspector",
    number: "05",
    label: "检查器",
    eyebrow: "改这一条",
    description: "右栏。评级、标签、章节归属、同一镜头的多条与 AI 描述常驻;技术检查、画面评分、声音与调色、相似镜头是折叠段。",
  },
] as const;

export interface SettingsHelpTopic {
  id: string;
  label: string;
  eyebrow: string;
  description: string;
  /** 这个主题回答了哪些设置分区的问题；用于校验每个分区都有对应帮助。 */
  sections: readonly SettingsSectionId[];
  paragraphs: readonly string[];
}

export const SETTINGS_HELP_TOPICS: readonly SettingsHelpTopic[] = [
  {
    id: "settings",
    label: "设置页导览",
    eyebrow: "设置",
    description: "设置侧栏的每个分区做什么、什么时候该去看它。",
    sections: [
      "appearance",
      "performance",
      "timeline",
      "tools",
      "analysis",
      "generation",
      "privacy",
      "about",
      "cache",
    ],
    paragraphs: [
      "外观：主题跟随系统或手动锁定明暗，界面尺度覆盖 90%–130% 四档，只影响阅读密度，不改变导出结果。",
      "性能:后台同时处理几条与预览小文件开关;机器越弱建议同时处理的条数越少，内存档位（自动 / 标准 / 省内存）决定后台任务在低内存时让路的力度。",
      "旅行时间：多设备时钟校正，把不同相机/手机的拍摄时间对齐到统一的 Canonical Journey Time，避免按时间线索排序时素材错位。",
      "工具链:视频处理、媒体信息、转写与画面识别组件的本机位置与检测状态;留空自动在本机搜索，缺失只降级不损坏原片。每个组件存在上一版本时会出现「回滚到上一版」按钮，装了新版本发现有问题可以一键退回。",
      "分析与 AI:场景/相似度/抖动阈值,自动选优的六项权重,以及可选的增强分析开关、provider 锁定与月度调用预算。",
      "云端补镜（MiniMax）：默认关闭，密钥只写入 macOS 钥匙串、界面上永不回显；启用后按月度预算生成缺口镜头，生成的片子只落到素材库的 generated/ 目录，原素材目录不会被写入，实际扣费以 MiniMax 平台账单为准。",
      "隐私与诊断：本地优先的确切边界、诊断日志位置与保留期限，以及崩溃报告由谁控制——这里不产生新的上传行为，只是把已经存在的规则说清楚。",
      "帮助与关于：中文工作指南、安装向导入口与应用版本、开源许可清单。",
      "缓存与重建：清空可重建的分析缓存并触发重新计算；评级、片段和原始素材不受影响，是这个分区里唯一的破坏性操作。",
    ],
  },
  {
    id: "privacy",
    label: "隐私与诊断怎么读",
    eyebrow: "隐私",
    description: "本机默认处理素材，诊断信息的去向逐条列出。",
    sections: ["privacy"],
    paragraphs: [
      "原片、缩略图、转写文本、GPS 坐标、素材绝对路径与完整项目内容永远留在本机，不因为开启 LLM 增强而改变。",
      "诊断日志只保留最近 7 天，且素材路径在写入前已脱敏为文件名；「打开日志目录」按钮直接定位到这些文件，方便你自己核查后再决定要不要提供给他人。",
      "旅剪不内置崩溃上报服务；是否发送诊断数据完全由 macOS 系统设置的“隐私与安全性 › 分析与改进”控制，应用侧没有也不会新增一个形同虚设的开关。",
      "LLM 增强按调用类型（AI 描述 / 导演问答 / 叙事编排）分别限定了能发送的字段，详见「隐私与诊断」分区的发送内容明细；未启用时这条路径完全不会被触发。",
    ],
  },
] as const;

export function helpTopicForSection(sectionId: SettingsSectionId): SettingsHelpTopic | null {
  return (
    SETTINGS_HELP_TOPICS.find(
      (topic) => topic.id === sectionId || topic.sections.includes(sectionId),
    ) ?? null
  );
}

export const HELP_FAQS = [
  {
    id: "ime-search",
    question: "搜索英文文件名时输入法弹出中文候选怎么办?",
    answer:
      "全量搜索(侧栏搜索框与 ⌘K 面板)按原文匹配文件名、转写、AI 描述、画面标签与画面文字。输入英文文件名片段时请先切换到英文输入(macOS 默认 Ctrl+空格),中文输入法的候选窗会拦截字母;中文关键词(转写/描述/标签)可直接用中文输入搜索。也可以不切输入法,直接打两个字母以上的拼音或首字母(比如 lvpai / lp)命中中文文件名、标签或章节标题里的「旅拍」。",
  },
  {
    id: "missing-tools",
    question: "工具链显示“未找到”怎么办？",
    answer:
      "先到设置页的“工具链”查看视频处理、转写与画面识别组件的状态。可填写本机程序位置后重新检测；缺失的能力会降级或暂停，但不会损坏原片。",
  },
  {
    id: "jianying-version",
    question: "剪映版本不同，还能打开交付结果吗？",
    answer:
      "稳定交付包是首选路径，适合跨版本导入素材与清单。可编辑草稿属于实验能力，剪映升级后应先做小项目试导；如果版本金丝雀未通过，请继续使用稳定包。",
  },
  {
    id: "encryption",
    question: "素材、登记信息与加密分别是什么关系？",
    answer:
      "旅剪默认在本机处理素材，原片保持只读。项目数据库和缓存位于本机应用数据目录；是否具备静态加密取决于 macOS 磁盘加密（建议开启 FileVault）。导出包只有在你主动交付时才会离开本机。",
  },
] as const;

/**
 * R12 §1:「流水线手册」——四步各 3 行「怎么做」+ 该步的快捷键。快捷键**不手抄**:按 id 从
 * `KEYBOARD_SHORTCUT_GROUPS` 取(全局键位那组与 `useGlobalHotkeys.globalHotkeyIntent` 的对应
 * 关系由 `HelpOverlay.test` 钉住),表改了这里自动跟着变。
 */
export interface PipelineManualStep {
  step: 1 | 2 | 3 | 4;
  title: string;
  /** 恰好 3 行。 */
  howTo: readonly [string, string, string];
  /** 从快捷键总表按 id 取的键位。 */
  shortcutIds: readonly string[];
}

export const PIPELINE_MANUAL: readonly PipelineManualStep[] = [
  {
    step: 1,
    title: "导入",
    howTo: [
      "点顶栏「下一步:导入素材」或 ⌘I,选一个装着视频的文件夹;原片不会被改动。",
      "等状态条的「分析」走完;分析中也能先看、先收藏。",
      "导入完成后,媒体池按拍摄时间排好,镜头带自动分出章节。",
    ],
    shortcutIds: ["open-import", "command-palette", "escape"],
  },
  {
    step: 2,
    title: "挑选",
    howTo: [
      "最快的路:点「下一步:自动挑选」,软件挑出精选段并排进镜头带(收藏或打过星就只在那些里挑,没有就按全部素材挑)。",
      "手动的路:在媒体池看到喜欢的按 F 收藏、按 1–5 打星;不要的按 X。",
      "在监视器里按 Enter 采用建议段,或 I / O 打点后按 S 保存自己的片段。",
    ],
    shortcutIds: ["favorite", "reject", "stars", "clear-rating", "mark-range", "save-range", "toggle-playback"],
  },
  {
    step: 3,
    title: "排列",
    howTo: [
      "点「下一步:排到镜头带」(或镜头带空态的「一键排入」),精选段按章节排好。",
      "拖镜块换顺序,或点镜块上的「往前 / 往后」;每章一行。",
      "章节有缺口就从挑好的片段里选一条补上;这章不想要就点「这章够了」。",
    ],
    shortcutIds: ["cycle-pane", "immersive", "step-frame"],
  },
  {
    step: 4,
    title: "导出",
    howTo: [
      "点「下一步:导出」,默认「导出片段」——只导片段和收藏的视频文件到你选的文件夹。",
      "要整包(视频 + 参考粗剪 + 镜头表 + 说明)就切「完整交付包」;装了剪映可以出「剪映草稿」。",
      "完成后「在 Finder 中显示」;有几个没导出来就「只重试失败的」。",
    ],
    shortcutIds: ["open-settings", "open-help"],
  },
] as const;

/** 按 id 从快捷键总表取;找不到的 id 直接漏掉(测试会把漏掉的当错)。 */
export function shortcutsById(ids: readonly string[]): KeyboardShortcut[] {
  const all = KEYBOARD_SHORTCUT_GROUPS.flatMap((group) => group.shortcuts);
  return ids.map((id) => all.find((shortcut) => shortcut.id === id)).filter((shortcut): shortcut is KeyboardShortcut => shortcut !== undefined);
}
