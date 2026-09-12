import type { JSX } from "react";

/**
 * 套件图标(规格 §2):16px 视窗、1.5px 描边、`currentColor`、`aria-hidden`。全部手绘,
 * 不引图标库。24 个任务书图标 + 设置九分区。路径按 16 格画,端点落在 .5 上,1.5 描边
 * 在 1x 下仍是整像素边缘 —— 这是「图标要 crisp」的全部秘诀。
 */
export type IconName =
  | "import" | "deliver" | "settings" | "search" | "play" | "pause" | "prev" | "next"
  | "volume" | "volume-off" | "fullscreen" | "mark-in" | "mark-out" | "save" | "star" | "heart"
  | "x" | "check" | "chevron-down" | "chevron-right" | "grip" | "plus" | "close" | "info" | "warning" | "film"
  | "settings-appearance" | "settings-performance" | "settings-timeline" | "settings-tools"
  | "settings-analysis" | "settings-generation" | "settings-privacy" | "settings-about" | "settings-cache";

export type IconSize = 12 | 16 | 20 | 32;

/** 星与心可以 `filled`(收藏态);其余图标忽略该 prop。 */
const FILLABLE: ReadonlySet<IconName> = new Set<IconName>(["star", "heart"]);

/** 每个图标的路径:一段 `d`,或 `<path>`/`<circle>`/`<line>` 的元素数组。 */
type Shape =
  | { d: string }
  | { circle: [cx: number, cy: number, r: number] }
  | { line: [x1: number, y1: number, x2: number, y2: number] };

const STAR = "M8 1.75l1.9 3.95 4.35.6-3.15 3.05.75 4.35L8 11.6l-3.85 2.1.75-4.35L1.75 6.3l4.35-.6z";
const HEART = "M8 13.5S2 9.9 2 5.9C2 4.1 3.4 2.75 5.05 2.75c1.2 0 2.25.65 2.95 1.75.7-1.1 1.75-1.75 2.95-1.75C12.6 2.75 14 4.1 14 5.9c0 4-6 7.6-6 7.6z";

const SHAPES: Record<IconName, readonly Shape[]> = {
  import: [{ d: "M8 2.5v8" }, { d: "M4.75 7.25L8 10.5l3.25-3.25" }, { d: "M2.5 11v1.5a1 1 0 001 1h9a1 1 0 001-1V11" }],
  deliver: [{ d: "M8 1.75L14 5v6L8 14.25 2 11V5z" }, { d: "M2.25 5.1L8 8.25l5.75-3.15" }, { d: "M8 8.25v6" }],
  settings: [
    { circle: [8, 8, 2.25] },
    { d: "M8 1.75v1.9M8 12.35v1.9M1.75 8h1.9M12.35 8h1.9M3.58 3.58l1.35 1.35M11.07 11.07l1.35 1.35M3.58 12.42l1.35-1.35M11.07 4.93l1.35-1.35" },
  ],
  search: [{ circle: [7, 7, 4.25] }, { d: "M10.25 10.25L14 14" }],
  play: [{ d: "M4.5 2.75v10.5l8.25-5.25z" }],
  pause: [{ d: "M4.75 3v10M11.25 3v10" }],
  prev: [{ d: "M12 3.25v9.5L5.5 8z" }, { d: "M3.5 3v10" }],
  next: [{ d: "M4 3.25v9.5L10.5 8z" }, { d: "M12.5 3v10" }],
  volume: [{ d: "M2.5 6h2.25L8.25 3v10L4.75 10H2.5z" }, { d: "M10.5 5.75a3.2 3.2 0 010 4.5" }, { d: "M12.5 3.75a6 6 0 010 8.5" }],
  "volume-off": [{ d: "M2.5 6h2.25L8.25 3v10L4.75 10H2.5z" }, { d: "M10.5 6l3.5 4M14 6l-3.5 4" }],
  fullscreen: [{ d: "M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" }],
  "mark-in": [{ d: "M4 2.5v11" }, { d: "M4 8h8.5" }, { d: "M9.5 5l3 3-3 3" }],
  "mark-out": [{ d: "M12 2.5v11" }, { d: "M3.5 8H12" }, { d: "M6.5 5l-3 3 3 3" }],
  save: [{ d: "M3.5 2.5h7l3 3v8h-10z" }, { d: "M5.5 2.5v3.25h4.5V2.5" }, { d: "M5.5 13.5v-4h5v4" }],
  star: [{ d: STAR }],
  heart: [{ d: HEART }],
  x: [{ d: "M4 4l8 8M12 4l-8 8" }],
  // 胶片条:封面缺失 / 空章占位用的中性图形(R9 D2 / D4),不是「坏图」问号。
  film: [{ d: "M2.5 3.5h11v9h-11z" }, { d: "M5 3.5v9M11 3.5v9" }, { d: "M2.5 6.5H5M2.5 9.5H5M11 6.5h2.5M11 9.5h2.5" }],
  check: [{ d: "M2.75 8.5l3.25 3.25 7.25-7.5" }],
  "chevron-down": [{ d: "M4 6l4 4 4-4" }],
  "chevron-right": [{ d: "M6 4l4 4-4 4" }],
  grip: [
    { circle: [6, 4, 0.75] }, { circle: [10, 4, 0.75] },
    { circle: [6, 8, 0.75] }, { circle: [10, 8, 0.75] },
    { circle: [6, 12, 0.75] }, { circle: [10, 12, 0.75] },
  ],
  plus: [{ d: "M8 3v10M3 8h10" }],
  close: [{ circle: [8, 8, 6.25] }, { d: "M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5" }],
  info: [{ circle: [8, 8, 6.25] }, { d: "M8 7.25v4" }, { circle: [8, 5, 0.4] }],
  warning: [{ d: "M8 2.25l6.25 11H1.75z" }, { d: "M8 6.5v3.25" }, { circle: [8, 11.6, 0.4] }],
  "settings-appearance": [{ circle: [8, 8, 6.25] }, { d: "M8 1.75v12.5" }, { d: "M8 4.5a3.5 3.5 0 010 7" }],
  "settings-performance": [{ d: "M2.25 11.5a5.75 5.75 0 0111.5 0" }, { d: "M8 11.5l2.9-3.9" }, { circle: [8, 11.5, 0.4] }, { d: "M2.25 11.5h1.5M12.25 11.5h1.5" }],
  "settings-timeline": [{ circle: [8, 8, 6.25] }, { d: "M8 4.75V8l2.25 1.75" }],
  "settings-tools": [{ d: "M9.75 2.5a3.25 3.25 0 00-3.4 4.4L2.5 10.75l2.75 2.75 3.85-3.85a3.25 3.25 0 004.4-3.4l-2 2-2-.5-.5-2z" }],
  "settings-analysis": [{ d: "M2.5 13.5h11" }, { d: "M4.5 10.5V7M8 10.5V4M11.5 10.5V6" }],
  "settings-generation": [{ d: "M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z" }, { d: "M12.75 11.25l.5 1.25 1.25.5-1.25.5-.5 1.25-.5-1.25-1.25-.5 1.25-.5z" }],
  "settings-privacy": [{ d: "M8 1.75L13.5 4v3.75c0 3.3-2.3 5.55-5.5 6.5-3.2-.95-5.5-3.2-5.5-6.5V4z" }, { d: "M5.75 8.25L7.25 9.75l3-3.25" }],
  "settings-about": [{ circle: [8, 8, 6.25] }, { d: "M6.25 6.5a1.75 1.75 0 113 1.25c-.6.5-1.25.85-1.25 1.75" }, { circle: [8, 11.75, 0.4] }],
  "settings-cache": [{ d: "M2.75 4.25c0-1.1 2.35-2 5.25-2s5.25.9 5.25 2-2.35 2-5.25 2-5.25-.9-5.25-2z" }, { d: "M2.75 4.25V8c0 1.1 2.35 2 5.25 2s5.25-.9 5.25-2V4.25" }, { d: "M2.75 8v3.75c0 1.1 2.35 2 5.25 2s5.25-.9 5.25-2V8" }],
};

export const ICON_NAMES: readonly IconName[] = Object.keys(SHAPES) as IconName[];

export interface IconProps {
  name: IconName;
  size?: IconSize;
  /** 星 / 心的收藏态;其余图标忽略。 */
  filled?: boolean;
  className?: string;
}

export function Icon({ name, size = 16, filled = false, className }: IconProps): JSX.Element {
  const fill = filled && FILLABLE.has(name) ? "currentColor" : "none";
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={fill}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `ui-icon ${className}` : "ui-icon"}
      data-icon={name}
    >
      {SHAPES[name].map((shape, index) => {
        if ("circle" in shape) {
          const [cx, cy, r] = shape.circle;
          // 极小圆(点)用 fill 画,描边画不出实心点。
          return r < 0.5 ? <circle key={index} cx={cx} cy={cy} r={r + 0.35} fill="currentColor" stroke="none" /> : <circle key={index} cx={cx} cy={cy} r={r} />;
        }
        if ("line" in shape) {
          const [x1, y1, x2, y2] = shape.line;
          return <line key={index} x1={x1} y1={y1} x2={x2} y2={y2} />;
        }
        return <path key={index} d={shape.d} />;
      })}
    </svg>
  );
}
