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

export const HELP_FAQS = [
  {
    id: "ime-search",
    question: "搜索英文文件名时输入法弹出中文候选怎么办?",
    answer:
      "全量搜索(侧栏搜索框与 ⌘K 面板)按原文匹配文件名、转写、AI 描述与八维标签。输入英文文件名片段时请先切换到英文输入(macOS 默认 Ctrl+空格),中文输入法的候选窗会拦截字母;中文关键词(转写/描述/标签)可直接用中文输入搜索。",
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
