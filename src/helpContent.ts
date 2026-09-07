import type { SettingsSectionId } from "./settingsSections";

export interface KeyboardShortcut {
  id: string;
  keys: readonly string[];
  action: string;
  detail: string;
}

export interface KeyboardShortcutGroup {
  id: string;
  label: string;
  eyebrow: string;
  shortcuts: readonly KeyboardShortcut[];
}

export const SELECTION_SHORTCUTS: readonly KeyboardShortcut[] = [
  { id: "favorite", keys: ["F"], action: "收藏", detail: "把当前素材标为保留" },
  { id: "reject", keys: ["X"], action: "拒绝", detail: "把当前素材标为不采用" },
  { id: "stars", keys: ["1–5"], action: "星级", detail: "为当前素材设置一至五星" },
  { id: "clear-rating", keys: ["0"], action: "清除评级", detail: "同时清除收藏、拒绝与星级" },
  { id: "expand-stack", keys: ["Tab"], action: "展开 Stack", detail: "展开或收起当前普通视觉 Shot Stack；信息与人物 Stack 始终保留候选" },
  { id: "browse-stack", keys: ["↑", "↓"], action: "切换候选", detail: "在已展开 Stack 中移动当前候选，不立即改写首选" },
  { id: "replace-stack", keys: ["Enter"], action: "替换首选", detail: "把当前候选锁定为 Stack 首选" },
  { id: "lock-stack", keys: ["L"], action: "锁定候选", detail: "锁定或恢复当前 Stack 候选" },
  { id: "reject-stack", keys: ["R"], action: "排除候选", detail: "永久排除候选但不删除素材" },
  { id: "immersive-player", keys: ["Space"], action: "沉浸播放", detail: "打开当前素材的原片播放器" },
] as const;

export const PLAYER_SHORTCUTS: readonly KeyboardShortcut[] = [
  { id: "step-back-second", keys: ["J"], action: "回退一秒", detail: "暂停并向前回看一秒" },
  { id: "pause", keys: ["K"], action: "暂停", detail: "暂停当前播放" },
  { id: "play", keys: ["L"], action: "播放", detail: "继续播放当前素材" },
  { id: "step-frame", keys: ["←", "→"], action: "逐帧", detail: "向前或向后移动一帧" },
  { id: "mark-range", keys: ["I", "O"], action: "设置入出点", detail: "标记一个精选片段的边界" },
  { id: "save-range", keys: ["S"], action: "保存精选段", detail: "保存当前完整的入出点" },
  { id: "toggle-playback", keys: ["Space"], action: "播放 / 暂停", detail: "切换当前播放状态" },
  { id: "exit-player", keys: ["Esc"], action: "返回筛片", detail: "关闭沉浸播放器" },
] as const;

export const KEYBOARD_SHORTCUT_GROUPS: readonly KeyboardShortcutGroup[] = [
  {
    id: "selection",
    label: "筛片墙",
    eyebrow: "SELECT",
    shortcuts: SELECTION_SHORTCUTS,
  },
  {
    id: "player",
    label: "沉浸播放器",
    eyebrow: "PLAYER",
    shortcuts: PLAYER_SHORTCUTS,
  },
] as const;

export const WORKFLOW_STEPS = [
  {
    id: "import",
    number: "01",
    label: "导入",
    eyebrow: "INGEST",
    description: "选择相机卡、移动硬盘或本地目录；旅剪只建立索引，不改写原片。",
  },
  {
    id: "select",
    number: "02",
    label: "筛片",
    eyebrow: "SELECT",
    description: "浏览胶片墙，用收藏、评级与功能感知 Shot Stack 收束素材；信息和人物镜头不会按画质淘汰。",
  },
  {
    id: "mark",
    number: "03",
    label: "打点",
    eyebrow: "MARK",
    description: "进入沉浸播放，用 I / O 标记边界，再按 S 保存真正有用的片段。",
  },
  {
    id: "story",
    number: "04",
    label: "故事",
    eyebrow: "STORY",
    description: "把精选段放进章节，调整次序，形成可解释的粗剪结构。",
  },
  {
    id: "deliver",
    number: "05",
    label: "交付",
    eyebrow: "DELIVER",
    description: "生成稳定交付包，再交给剪映完成精剪、字幕、调色与发布。",
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
    eyebrow: "SETTINGS",
    description: "设置侧栏的每个分区做什么、什么时候该去看它。",
    sections: [
      "appearance",
      "performance",
      "timeline",
      "tools",
      "analysis",
      "privacy",
      "about",
      "cache",
    ],
    paragraphs: [
      "外观：主题跟随系统或手动锁定明暗，界面尺度覆盖 90%–130% 四档，只影响阅读密度，不改变导出结果。",
      "性能：并发 worker 数与代理文件开关；机器越弱建议 worker 越少，内存档位（auto / 保守 / 宽松）决定后台任务在低内存时让路的力度。",
      "旅行时间：多设备时钟校正，把不同相机/手机的拍摄时间对齐到统一的 Canonical Journey Time，避免按时间线索排序时素材错位。",
      "工具链：FFmpeg、FFprobe、whisper-cli 与 Chinese-CLIP sidecar 的本机路径与检测状态；留空自动搜索 PATH，缺失只降级不损坏原片。每个组件存在上一版本时会出现「回滚到上一版」按钮，装了新版本发现有问题可以一键退回。",
      "分析与 AI：场景/相似度/抖动阈值，AI Best Take 六轴权重，以及可选的 LLM 增强开关、provider 锁定与月度调用预算。",
      "隐私与诊断：本地优先的确切边界、诊断日志位置与保留期限，以及崩溃报告由谁控制——这里不产生新的上传行为，只是把已经存在的规则说清楚。",
      "帮助与关于：中文工作指南、安装向导入口与应用版本、开源许可清单。",
      "缓存与重建：清空可重建的分析缓存并触发重新计算；评级、片段和原始素材不受影响，是这个分区里唯一的破坏性操作。",
    ],
  },
  {
    id: "privacy",
    label: "隐私与诊断怎么读",
    eyebrow: "PRIVACY",
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
      "全量搜索(侧栏搜索框与 ⌘K 面板)按原文匹配文件名、转写、AI 描述、八维标签与画面文字。输入英文文件名片段时请先切换到英文输入(macOS 默认 Ctrl+空格),中文输入法的候选窗会拦截字母;中文关键词(转写/描述/标签)可直接用中文输入搜索。也可以不切输入法,直接打两个字母以上的拼音或首字母(比如 lvpai / lp)命中中文文件名、标签或章节标题里的「旅拍」。",
  },
  {
    id: "missing-tools",
    question: "工具链显示“未找到”怎么办？",
    answer:
      "先到设置页的“工具链”查看 FFmpeg、FFprobe、Whisper 与 Chinese-CLIP 状态。可填写本机可执行文件路径后重新检测；缺失的能力会降级或暂停，但不会损坏原片。",
  },
  {
    id: "jianying-version",
    question: "剪映版本不同，还能打开交付结果吗？",
    answer:
      "稳定交付包是首选路径，适合跨版本导入素材与清单。可编辑草稿属于实验能力，剪映升级后应先做小项目试导；如果版本金丝雀未通过，请继续使用稳定包。",
  },
  {
    id: "encryption",
    question: "素材、索引与加密分别是什么关系？",
    answer:
      "旅剪默认在本机处理素材，原片保持只读。项目数据库和缓存位于本机应用数据目录；是否具备静态加密取决于 macOS 磁盘加密（建议开启 FileVault）。导出包只有在你主动交付时才会离开本机。",
  },
] as const;
