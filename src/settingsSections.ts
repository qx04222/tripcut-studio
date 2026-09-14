// 设置分区 id 的单一定义源。SettingsPage 用它渲染侧栏；helpContent 用它把每个
// 帮助主题和它覆盖的分区绑定，避免两边各写一份 id 列表后悄悄漂移。
export type SettingsSectionId =
  | "appearance"
  | "keymap"
  | "performance"
  | "timeline"
  | "tools"
  | "analysis"
  | "generation"
  | "privacy"
  | "about"
  | "cache";
