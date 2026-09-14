/**
 * 原生 mpv 视图的区域矩形怎么算(R9 D5)。
 *
 * 原生 NSView 不受 DOM 的 overflow 约束:监视器栏变矮时 DOM 井被舞台的
 * overflow:hidden 裁掉,原生视图却仍按井的完整矩形画,压到控件条和镜头带
 * 带头上(实机 1600×1000 切到「旅程」页签的截图)。所以提交给后端的矩形
 * 必须先与每一层会裁切它的祖先(overflow ≠ visible)以及窗口视口求交。
 */

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PlayerViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 两个矩形的交集;不相交时宽或高为 0(由 rectToPlayerViewport 判无效)。 */
export function intersectRects(a: RectLike, b: RectLike): RectLike {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function rectToPlayerViewport(rect: RectLike): PlayerViewportRect | null {
  const values = [rect.left, rect.top, rect.width, rect.height];
  if (!values.every(Number.isFinite)
    || rect.left < 0
    || rect.top < 0
    || rect.width < 2
    || rect.height < 2) {
    return null;
  }
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/**
 * 画面元素**可见**的那块矩形:与所有会裁切它的祖先(overflow 不是 visible 的)
 * 及窗口视口求交。舞台 / 栏 / 面板任何一层把它裁掉多少,原生视图就少画多少。
 */
export function visibleSurfaceRect(surface: Element, win: Window = window): RectLike {
  let rect: RectLike = surface.getBoundingClientRect();
  // Z-17:沉浸层是 position:fixed,它**不被**监视器栏 / 舞台的 overflow 裁切
  // (fixed 只认视口,除非某个祖先用 transform / filter / contain 把自己变成了
  // 包含块)。不看这一点就会把整窗的画面裁成监视器栏那 650×520 的小框。
  let escaping = isFixed(win.getComputedStyle(surface));
  for (let node = surface.parentElement; node !== null; node = node.parentElement) {
    const style = win.getComputedStyle(node);
    if (escaping && formsContainingBlockForFixed(style)) escaping = false;
    if (!escaping && clipsDescendants(style)) rect = intersectRects(rect, node.getBoundingClientRect());
    if (!escaping && isFixed(style)) escaping = true;
  }
  return intersectRects(rect, { left: 0, top: 0, width: win.innerWidth, height: win.innerHeight });
}

function isFixed(style: CSSStyleDeclaration): boolean {
  return style.position === "fixed";
}

function clipsDescendants(style: CSSStyleDeclaration): boolean {
  return [style.overflow, style.overflowX, style.overflowY].some(
    (value) => value !== "" && value !== "visible",
  );
}

/** transform / filter / perspective / contain 会让祖先成为 fixed 后代的包含块,裁切从那一层起重新算数。 */
function formsContainingBlockForFixed(style: CSSStyleDeclaration): boolean {
  const isSet = (value: string | undefined) => value !== undefined && value !== "" && value !== "none";
  const contain = style.contain ?? "";
  return isSet(style.transform)
    || isSet(style.filter)
    || isSet(style.perspective)
    || isSet(style.backdropFilter)
    || /transform|filter|perspective/.test(style.willChange ?? "")
    || /paint|layout|strict|content/.test(contain);
}

/** 舞台内能放下的最大 16:9(或任意比例)井:宽高都不超过舞台内容盒。 */
export function fitWell(stageWidth: number, stageHeight: number, ratio = 16 / 9): { width: number; height: number } {
  const width = Math.max(0, stageWidth);
  const height = Math.max(0, stageHeight);
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  if (width / height > ratio) return { width: Math.floor(height * ratio), height: Math.floor(height) };
  return { width: Math.floor(width), height: Math.floor(width / ratio) };
}
