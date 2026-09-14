/**
 * R12 车道 C:用户可见文案与 AX 名的共享常量(规格 §4 术语 v2)。
 * 冻结的 AX 名改名都从这里出:断言与探针锚点引用同一份字符串,改一个字全部跟着动。
 * 旧名 → 新名对照见 `.superpowers/sdd/r12/lane-terms-report.md` §2 与 design-system.md §11。
 */

/** 同一镜头里第 n 条候选的 AX 名(原「Take n · 文件名」)。 */
export const takeLabel = (index: number, name: string): string => `第 ${index} 条 · ${name}`;

/** 同一镜头候选组的 AX 名(原「{scene_name} 的候选」)。 */
export const stackGroupLabel = (sceneName: string): string => `同一镜头 · ${sceneName}`;

/** 池卡片角标(原「n 条候选」)。 */
export const stackCountLabel = (count: number): string => `同一镜头 ${count} 条`;

/** 检查器折叠段标题(原「八维评分」「音轨与 LUT」)。 */
export const INSPECTOR_TITLES = {
  techcheck: "技术检查",
  dimensions: "画面评分",
  ai: "AI 描述",
  audio: "声音与调色",
  similar: "相似镜头",
} as const;

/** 媒体池「更多筛选」里的下拉(原「八维筛选」)。 */
export const DIMENSION_FILTER_LABEL = "画面筛选";

/** 「画布方向」→「画面方向」(集表单与交付抽屉共用)。 */
export const ORIENTATION_LABEL = "画面方向";
export const DELIVER_ORIENTATION_LABEL = "本次交付画面方向";

/** 导入抽屉「任务」分页的进度节(原「索引进度」)。 */
export const IMPORT_PROGRESS_LABEL = "导入进度";

/** 首启弹窗 / 设置「安装检查」卡里的两项可选组件(规格 §4)。 */
export const OPTIONAL_TRANSCRIBE_TITLE = "转写(可选)";
export const OPTIONAL_VISION_TITLE = "画面识别(可选)";

/** 技术检查第一行:「1920×1080 · 30 帧/秒 · 竖屏」,读不到的部分直接省略。 */
export function pictureSummary(parts: { size?: string | null; fps?: string | null; orientation?: string | null }): string {
  return [parts.size, parts.fps, parts.orientation].filter((part): part is string => Boolean(part)).join(" · ");
}

/** X-05(R12 验收):交付抽屉的 dialog 名,由冻结名「生成交付包」解冻改名——新手词「导出」。 */
export const DELIVER_DRAWER_TITLE = "导出";

/* ---- R16 车道 B(章节与批量;规格 §1 菜单文案与 AX 名) ---- */

/** 章头「···」按钮与它弹出的菜单共用的 AX 名。 */
export const CHAPTER_MENU_LABEL = (title: string): string => `章操作 · ${title}`;
/** 章头内联改名输入框的 AX 名。 */
export const CHAPTER_TITLE_INPUT_LABEL = "章节名";
/** 章头菜单项(顺序冻结:重命名 · 并入上一章 · 这章够了 / 还是要镜头 · 删除这一章…)。 */
export const CHAPTER_MENU_ITEMS = {
  rename: "重命名",
  mergeUp: "并入上一章",
  skip: "这章够了",
  unskip: "还是要镜头",
  delete: "删除这一章…",
} as const;
/** 删章确认卡的 AX 名与按钮。 */
export const CHAPTER_DELETE_CONFIRM_LABEL = "确认删除章";
export const CHAPTER_DELETE_BUTTON = "删除这一章";

/** 批量菜单项:多选时项目名带「(n 条)」(与「导出所选（n 条）…」同一写法);单条不带。 */
export const withCount = (label: string, count: number): string => menuLabelWithCount(label, count);
/** 素材卡菜单里由车道 B 追加的三项(收藏 / 拒绝 / 清除评级)。 */
export const RATING_MENU_ITEMS = { favorite: "收藏", reject: "拒绝", clear: "清除评级" } as const;

/** 集的「···」菜单项(切集弹层与首页卡同一份;「删除这一集」是 R15 冻结名)。 */
export const EPISODE_MENU_ITEMS = { rename: "重命名", delete: "删除这一集" } as const;
/** 任意集内联改名表单与输入框的 AX 名(「集标题」已被「重命名本集」整表单占用)。 */
export const EPISODE_RENAME_FORM_LABEL = "重命名集";
export const EPISODE_RENAME_INPUT_LABEL = "新的集标题";
/* ---------------------------------------------------------------------------------------------
 * R16 §1(车道 A):实体菜单的项目文案与 AX 名。同一实体在不同栏里菜单项完全一致 —— 三个入口
 * (媒体池卡片右键 / 检查器头部「···」/ 缺失页)都从这里取字,改一个字全部跟着动。
 * AX 名 = 不带「…」、不带「(n 条)」的基名(与 R11 「导出所选」同一条纪律);可见文案多选时带 `(n 条)`。
 * ------------------------------------------------------------------------------------------- */

/** 素材卡菜单(媒体池 / 检查器头)。顺序就是规格 §1 的顺序。 */
export const CLIP_MENU = {
  favorite: "收藏",
  reject: "拒绝",
  clear: "清除评级",
  addToBand: "加入镜头带",
  export: "导出所选…",
  reveal: "在 Finder 中显示",
  remove: "移除素材…",
} as const;
export type ClipMenuId = keyof typeof CLIP_MENU;

/** 镜块菜单(镜头带)。 */
export const SHOT_MENU = {
  stepBack: "往前",
  stepForward: "往后",
  removeFromBand: "从镜头带移出",
  deleteSegment: "删除精选段",
  exportSegment: "导出这一段…",
} as const;
export type ShotMenuId = keyof typeof SHOT_MENU;

/** 菜单容器与「···」按钮的 AX 名。 */
export const CLIP_MENU_LABEL = "素材操作";
export const SHOT_MENU_LABEL = "镜块操作";
export const MORE_BUTTON_LABEL = "更多";

/** 多选时的可见文案:「移除素材(3 条)…」;单条原样。AX 名请用 `menuAriaLabel`。 */
export function menuLabelWithCount(label: string, count: number): string {
  if (count <= 1) return label;
  const ellipsis = label.endsWith("…");
  const base = ellipsis ? label.slice(0, -1) : label;
  return `${base}(${count} 条)${ellipsis ? "…" : ""}`;
}

/** 菜单项的 AX 名:去掉尾部「…」的基名(冻结用,不随多选变)。 */
export function menuAriaLabel(label: string): string {
  return label.endsWith("…") ? label.slice(0, -1) : label;
}

/** 撤销 toast:「已删除精选段 · 撤销」这一类的正文(按钮文字统一是「撤销」)。 */
export const UNDO_ACTION_LABEL = "撤销";
export const SEGMENT_DELETED_TOAST = "已删除精选段";
export const SHOT_REMOVED_TOAST = "已从镜头带移出";
export const NOTHING_TO_UNDO_TOAST = "没有可撤销的操作";
export const undoneToast = (label: string): string => `已撤销 · ${label}`;

/** 缺失页卷组:这个盘不会再回来了 → 走移除素材的后果预览。 */
export const VOLUME_GONE_LABEL = "这个盘不会再回来了…";
/** 移除确认卡(alertdialog)的 AX 名与按钮文案,与导入页那张同一份。 */
export const REMOVAL_CONFIRM_LABEL = "确认移除素材";
export const REMOVAL_CONFIRM_BUTTON = "确认移除，保留原视频";

/** 设置页各行(R16 P2-5 / P2-8 / P2-11 / P2-12 / P2-13)。 */
export const SETTINGS_ACTIONS = {
  recomputeMoments: "重新计算时刻分",
  rerunOcr: "重新识别画面文字",
  clearExportDir: "清除",
  resetOnboarding: "重置新手引导",
  resetLayout: "恢复默认布局",
  copyDiagnostics: "复制诊断信息",
} as const;
/** R16 §1 车道 C:素材卡菜单项「在 Finder 中显示」(P2-7)——与 `CLIP_MENU.reveal` 同一份字。 */
export const REVEAL_IN_FINDER_LABEL = CLIP_MENU.reveal;
