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
