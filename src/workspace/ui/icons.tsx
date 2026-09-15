import type { JSX } from "react";

/**
 * 套件图标(规格 §2 + R18 图标规范,见 `docs/design/design-system.md`「图标规范」):
 * 16 网格、活动区 12.5(四边各留 1.75,量的是**笔画中心线**)、`currentColor`、`aria-hidden`。
 *
 * 几何规则(由 `icons.geometry.test.ts` 钉住,不是注释里的说法):
 * - 所有坐标落 **.25 / .75 四分格**。1.5 描边中心在 `.25/.75` 时,2x 下的三个设备像素
 *   正好落格;落在整数或 `.5` 上反而是半像素(旧注释「端点落在 .5 上,1x 下是整像素边缘」
 *   两处都算错了)。
 * - 需要居中的单笔 / 奇数列取 **7.75**(不是 8,8 不在四分格上),整枚图标据此对齐。
 * - 相对指令的增量一律取 0.5 的整数倍:起点在格上,终点也就在格上。
 * - 不同子形状之间要么**相交/相接**(距离 ≈0),要么中心线距离 **≥ 2.0**(两条 1.5 描边
 *   之间至少留 0.5 的光)。
 * - 点只有一种:填充圆 r=0.75(`dot`),不再有「r<0.5 就偷偷改填充」的渲染期分支。
 * - 实心只给 `play` / `star` / `heart`(收藏态)/ `settings-appearance` 的半圆;其余全线稿。
 *
 * 全部手绘,不引图标库,不抄任何第三方资源。
 */
export type IconName =
  | "import" | "deliver" | "settings" | "search" | "play" | "pause" | "prev" | "next"
  | "volume" | "volume-off" | "fullscreen" | "mark-in" | "mark-out" | "save" | "star" | "heart"
  | "x" | "check" | "chevron-down" | "chevron-right" | "grip" | "plus" | "close" | "info" | "warning" | "film"
  | "settings-appearance" | "settings-performance" | "settings-timeline" | "settings-tools"
  | "settings-analysis" | "settings-generation" | "settings-privacy" | "settings-about" | "settings-cache"
  | "settings-keymap"
  | "arrow-left" | "arrow-right"
  | "more"
  | "tag" | "similar" | "takes" | "slot";

export type IconSize = 12 | 16 | 20 | 32;

/**
 * 按尺寸补偿描边(V-10):恒定 1.5 在 12px 下渲染成 1.13(发虚)、32px 下 3.0(发胖)。
 * 查表后四档渲染宽度分别是 1.31 / 1.5 / 1.75 / 1.9 px,看起来是同一支笔。
 */
export const STROKE_BY_SIZE: Readonly<Record<IconSize, number>> = { 12: 1.75, 16: 1.5, 20: 1.4, 32: 0.95 };

/** 星与心可以 `filled`(收藏态);其余图标忽略该 prop。 */
const FILLABLE: ReadonlySet<IconName> = new Set<IconName>(["star", "heart"]);

/** 点的唯一半径(填充圆)。全套只有这一种点。 */
export const DOT_RADIUS = 0.75;

/** 每个图标的形状:线稿 `d` / 填充 `fill` / 描边圆 `circle` / 点 `dot`。 */
type Shape =
  | { d: string }
  | { fill: string }
  | { circle: [cx: number, cy: number, r: number] }
  | { dot: [cx: number, cy: number] };

/** 6 齿齿轮外轮廓:外 R=6.0 / 根 r=4.25(齿高 1.75)、齿宽 3.0,顶点逐个吸到四分格。 */
const GEAR =
  "M13.75 6.25L13.75 9.25L11.75 8.75L10.75 10.75L11.75 12.25L9.25 13.75L8.75 11.75L6.75 11.75L6.25 13.75L3.75 12.25L4.75 10.75L3.75 8.75L1.75 9.25L1.75 6.25L3.75 6.75L4.75 4.75L3.75 3.25L6.25 1.75L6.75 3.75L8.75 3.75L9.25 1.75L11.75 3.25L10.75 4.75L11.75 6.75z";
/** 五角星:外 R=6.0 / 内 r=2.5,顶点吸到四分格。 */
const STAR =
  "M7.75 1.75L9.25 5.75L13.25 5.75L10.25 8.75L11.25 12.75L7.75 10.25L4.25 12.75L5.25 8.75L2.25 5.75L6.25 5.75z";
const HEART =
  "M7.75 13.25C4.25 10.75 1.75 8.25 1.75 5.75C1.75 3.75 3.25 2.25 5.25 2.25C6.75 2.25 7.75 3.25 7.75 4.25C7.75 3.25 8.75 2.25 10.25 2.25C12.25 2.25 13.75 3.75 13.75 5.75C13.75 8.25 11.25 10.75 7.75 13.25z";

const SHAPES: Record<IconName, readonly Shape[]> = {
  // 箭头尖 8.75 与托盘顶 10.75 拉开 2.0(V-12)。
  import: [
    { d: "M7.75 2.25v6.5" },
    { d: "M4.75 5.75l3 3 3-3" },
    { d: "M2.25 10.75v1.5a1.5 1.5 0 001.5 1.5h8a1.5 1.5 0 001.5-1.5v-1.5" },
  ],
  deliver: [{ d: "M7.75 1.75l5.5 3v6.5l-5.5 3-5.5-3v-6.5z" }, { d: "M2.25 4.75l5.5 3 5.5-3" }, { d: "M7.75 7.75v6.5" }],
  // V-04:8 齿、齿距 2.2 在 16px 下糊成毛边圈 → 6 齿,中心孔 r=2.0(到根圆留 2.25)。
  settings: [{ d: GEAR }, { circle: [7.75, 7.75, 2] }],
  search: [{ circle: [6.75, 6.75, 4] }, { d: "M9.75 9.75l3.5 3.5" }],
  // V-11:改实心,重心落回 x≈8(原来空心 + 重心 7.25,在圆钮里目视偏左)。
  play: [{ fill: "M5.25 3.25L13.75 7.75L5.25 12.25z" }],
  pause: [{ d: "M5.25 3.25v9.5" }, { d: "M10.25 3.25v9.5" }],
  prev: [{ d: "M3.25 3.75v9" }, { d: "M12.25 3.75v9L5.75 8.25z" }],
  next: [{ d: "M12.25 3.75v9" }, { d: "M3.25 3.75v9L9.75 8.25z" }],
  // V-13:两枚严格镜像(同居中于 7.75、同跨度 10),并排时重心不再一高一低。
  "arrow-left": [{ d: "M12.75 7.75H2.75" }, { d: "M6.75 3.75L2.75 7.75l4 4" }],
  "arrow-right": [{ d: "M2.75 7.75h10" }, { d: "M8.75 3.75l4 4-4 4" }],
  volume: [
    { d: "M2.25 6.25h2.5l3.5-3v9.5l-3.5-3h-2.5z" },
    { d: "M10.25 6.25a2.5 2.5 0 010 3.5" },
    { d: "M13.25 4.75a7 7 0 010 7" },
  ],
  // 静音叉与 `x` 同画法(两笔交叉、round 端点)。
  "volume-off": [
    { d: "M2.25 6.25h2.5l3.5-3v9.5l-3.5-3h-2.5z" },
    { d: "M10.75 6.25l3 3.5" },
    { d: "M13.75 6.25l-3 3.5" },
  ],
  fullscreen: [{ d: "M2.25 6.25V2.25H6.25M9.75 2.25h4V6.25M13.75 9.75v4H9.75M6.25 13.75H2.25V9.75" }],
  "mark-in": [{ d: "M3.75 2.75v10" }, { d: "M3.75 7.75h8.5" }, { d: "M9.25 4.75l3 3-3 3" }],
  "mark-out": [{ d: "M11.75 2.75v10" }, { d: "M11.75 7.75H3.25" }, { d: "M6.25 4.75l-3 3 3 3" }],
  // V-21:软盘是过时隐喻(业主口径「新手入门、开包即用」)→ 收进托盘的勾。
  save: [
    { d: "M4.75 5.25l2.5 2.5 4-5" },
    { d: "M2.25 9.75v2.5a1.5 1.5 0 001.5 1.5h8a1.5 1.5 0 001.5-1.5v-2.5" },
  ],
  star: [{ d: STAR }],
  heart: [{ d: HEART }],
  x: [{ d: "M3.75 3.75l8 8" }, { d: "M11.75 3.75l-8 8" }],
  // 胶片条:封面缺失 / 空章占位用的中性图形(R9 D2 / D4),不是「坏图」问号。
  film: [
    { d: "M2.25 3.25h11.5v9.5H2.25z" },
    { d: "M5.25 3.25v9.5M10.25 3.25v9.5" },
    { d: "M2.25 6.25H5.25M2.25 9.75H5.25M10.25 6.25h3.5M10.25 9.75h3.5" },
  ],
  check: [{ d: "M3.75 8.25l3 3 5.5-6.5" }],
  "chevron-down": [{ d: "M3.75 6.25l4 4 4-4" }],
  "chevron-right": [{ d: "M5.75 3.75l4 4-4 4" }],
  // V-03:六颗点统一成 r=0.75 填充点(原来 r=0.75 走描边分支,被 1.5 描边填成 3px 墨疙瘩)。
  grip: [
    { dot: [5.75, 3.75] }, { dot: [9.75, 3.75] },
    { dot: [5.75, 7.75] }, { dot: [9.75, 7.75] },
    { dot: [5.75, 11.75] }, { dot: [9.75, 11.75] },
  ],
  plus: [{ d: "M7.75 3.75v8" }, { d: "M3.75 7.75h8" }],
  // R15:「···」更多操作。同一种点,不再是 3.3px 疙瘩。
  more: [{ dot: [3.75, 7.75] }, { dot: [7.75, 7.75] }, { dot: [11.75, 7.75] }],
  close: [{ circle: [7.75, 7.75, 6] }, { d: "M5.75 5.75l4 4" }, { d: "M9.75 5.75l-4 4" }],
  info: [{ circle: [7.75, 7.75, 6] }, { d: "M7.75 7.25v3.5" }, { dot: [7.75, 5.25] }],
  warning: [{ d: "M7.75 1.75l6 12H1.75z" }, { d: "M7.75 6.75v3" }, { dot: [7.75, 11.75] }],
  // 真的半明半暗(实心半圆),不再是「圆里套个眼睛」。
  "settings-appearance": [{ circle: [7.75, 7.75, 6] }, { fill: "M7.75 1.75A6 6 0 017.75 13.75z" }],
  "settings-performance": [{ d: "M2.25 11.25a5.5 5.5 0 0111 0" }, { d: "M7.75 11.25l2-2.5" }, { dot: [7.75, 11.25] }],
  "settings-timeline": [{ circle: [7.75, 7.75, 6] }, { d: "M7.75 4.25v3.5l2.5 2" }],
  // 「工具与模型」分区:工具箱(箱体 + 提手 + 搭扣)。原来的扳手卡口只有 ~2px,
  // 16px 下看不出是扳手;环形扳手试过一版,放大看像拐杖 —— 工具箱是同尺寸下唯一不会误读的。
  "settings-tools": [
    { d: "M2.25 5.75h11.5v6.5a1 1 0 01-1 1h-9.5a1 1 0 01-1-1z" },
    { d: "M6.25 5.75V4.25a1 1 0 011-1h1a1 1 0 011 1v1.5" },
    { d: "M6.25 8.75h3" },
  ],
  "settings-analysis": [{ d: "M2.25 13.25h11.5" }, { d: "M4.75 10.75V6.75M7.75 10.75V3.75M10.75 10.75V5.75" }],
  // 单枚四角星,几何中心落回 7.75(原来大闪中心在 y=7、还挂一枚小闪)。
  "settings-generation": [{ d: "M7.75 2.25l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5z" }],
  "settings-privacy": [
    { d: "M7.75 1.75l5.5 2.5v3.5c0 3.25-2.25 5.5-5.5 6.5c-3.25-1-5.5-3.25-5.5-6.5V4.25z" },
    { d: "M5.75 7.75l1.5 1.5 3-3.5" },
  ],
  "settings-about": [
    { circle: [7.75, 7.75, 6] },
    { d: "M6.25 6.25a1.5 1.5 0 113 1c-.5.5-1 1-1 1.5" },
    { dot: [7.75, 11.25] },
  ],
  // R13:设置「快捷键」分区 —— 一枚键帽:圆角矩形 + 三颗键 + 空格条。
  "settings-keymap": [
    { d: "M3.25 3.75h9.5a1.5 1.5 0 011.5 1.5v5a1.5 1.5 0 01-1.5 1.5h-9.5a1.5 1.5 0 01-1.5-1.5v-5a1.5 1.5 0 011.5-1.5z" },
    { dot: [5.25, 6.25] }, { dot: [7.75, 6.25] }, { dot: [10.25, 6.25] },
    { d: "M5.25 9.25h5" },
  ],
  "settings-cache": [
    { d: "M2.75 4.25c0-1.5 2.25-2.5 5-2.5s5 1 5 2.5-2.25 2.5-5 2.5-5-1-5-2.5z" },
    { d: "M2.75 4.25v3.5c0 1.5 2.25 2.5 5 2.5s5-1 5-2.5V4.25" },
    { d: "M2.75 7.75v3.5c0 1.5 2.25 2.5 5 2.5s5-1 5-2.5V7.75" },
  ],
  // V-05 新增:标签。原来借放大镜(检查器「标签」分区),代码注释自己写着「用 search 代」。
  tag: [{ d: "M2.75 7.25V2.75h4.5l6 6-4.5 4.5z" }, { dot: [5.25, 5.25] }],
  // V-05 新增:相似镜头 = 两张错开的卡。原来也借放大镜,和同栏的「搜索」撞图标。
  similar: [{ d: "M5.75 2.75h7.5v7.5" }, { d: "M2.75 5.75h7.5v7.5h-7.5z" }],
  // V-05 新增:同一镜头的多条 = 层叠。原来借 settings-cache(数据库桶 = 缓存,不是多条素材)。
  takes: [
    { d: "M7.75 1.75l5.5 3-5.5 3-5.5-3z" },
    { d: "M2.25 8.25l5.5 3 5.5-3" },
    { d: "M2.25 11.25l5.5 3 5.5-3" },
  ],
  // V-05 新增:槽位 = 一对待填的方括号。原来借 settings-timeline(时钟 = 时间,不是章节归属)。
  slot: [{ d: "M4.75 3.25H2.75v9.5h2" }, { d: "M11.25 3.25h2v9.5h-2" }],
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
      strokeWidth={STROKE_BY_SIZE[size]}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `ui-icon ${className}` : "ui-icon"}
      data-icon={name}
    >
      {SHAPES[name].map((shape, index) => {
        if ("dot" in shape) {
          const [cx, cy] = shape.dot;
          return <circle key={index} cx={cx} cy={cy} r={DOT_RADIUS} fill="currentColor" stroke="none" />;
        }
        if ("circle" in shape) {
          const [cx, cy, r] = shape.circle;
          return <circle key={index} cx={cx} cy={cy} r={r} />;
        }
        if ("fill" in shape) {
          return <path key={index} d={shape.fill} fill="currentColor" stroke="none" />;
        }
        return <path key={index} d={shape.d} />;
      })}
    </svg>
  );
}
