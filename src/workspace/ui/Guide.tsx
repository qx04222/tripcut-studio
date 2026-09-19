import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type RefObject } from "react";

import { useOccludesPlayer } from "../usePlayerOcclusion";
import { Button } from "./Button";

export interface GuideProps {
  /** 目标元素:ref,或一个 CSS 选择器(如 `[data-guide="nav"]`)。 */
  anchor: string | RefObject<HTMLElement | null>;
  text: string;
  side: "top" | "bottom";
  /** 可选的「试试」动作(点了先做动作,再算看过)。 */
  tryLabel?: string;
  onTry?(): void;
  onDismiss(): void;
  /** 锚点等了 `anchorWaitMs` 还没出现 —— 由宿主决定让位给下一个。 */
  onAnchorMissing?(): void;
  anchorWaitMs?: number;
  /** 「1/7」这类小字,可省。 */
  counter?: string;
  /** 播放器正在放:气泡压到原生画面又躲不开时让位(隐藏、不登记遮挡),停下来再出。 */
  yieldWhilePlaying?: boolean;
}

const POLL_MS = 300;
const GAP = 10;
const BUBBLE_WIDTH = 300;
/** 监视器里 mpv 的画面节点(PlayerOverlay `.player-native-slot`):原生视图就压在这个矩形上。 */
const NATIVE_VIDEO_SELECTOR = ".player-native-slot";

interface BubbleRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function rectsIntersect(a: BubbleRect, b: BubbleRect): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/** 画面节点当前的矩形;没有(监视器没在放)或还没铺开(0 尺寸)时为 null。 */
function nativeVideoRect(): BubbleRect | null {
  const slot = document.querySelector<HTMLElement>(NATIVE_VIDEO_SELECTOR);
  if (!slot) return null;
  const rect = slot.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

interface Placement {
  left: number;
  top: number;
  arrowLeft: number;
  side: "top" | "bottom";
}

function resolveAnchor(anchor: GuideProps["anchor"]): HTMLElement | null {
  if (typeof anchor === "string") return document.querySelector<HTMLElement>(anchor);
  return anchor.current;
}

/**
 * 纯几何:气泡贴在锚点上方 / 下方,水平居中并夹在窗内;箭头指回锚点中心。
 * 给了 `avoid`(原生画面矩形)时,首选侧压到它而另一侧躲得开就换到另一侧——
 * 气泡一压到画面,原生视图就得整块藏起来(见 `useOccludesPlayer`),能躲就别让画面停。
 */
export function placeBubble(
  rect: BubbleRect,
  side: "top" | "bottom",
  viewport: { width: number; height: number },
  bubble: { width: number; height: number },
  avoid?: BubbleRect | null,
): Placement {
  const preferred = placeOnSide(rect, side, viewport, bubble);
  if (!avoid) return preferred;
  const preferredRect = { left: preferred.left, top: preferred.top, width: bubble.width, height: bubble.height };
  if (!rectsIntersect(preferredRect, avoid)) return preferred;
  const other = placeOnSide(rect, side === "top" ? "bottom" : "top", viewport, bubble);
  const otherRect = { left: other.left, top: other.top, width: bubble.width, height: bubble.height };
  return rectsIntersect(otherRect, avoid) ? preferred : other;
}

function placeOnSide(
  rect: BubbleRect,
  side: "top" | "bottom",
  viewport: { width: number; height: number },
  bubble: { width: number; height: number },
): Placement {
  const centerX = rect.left + rect.width / 2;
  const left = Math.max(8, Math.min(viewport.width - bubble.width - 8, centerX - bubble.width / 2));
  let resolved = side;
  if (side === "top" && rect.top - GAP - bubble.height < 8) resolved = "bottom";
  if (side === "bottom" && rect.top + rect.height + GAP + bubble.height > viewport.height - 8) resolved = "top";
  const top = resolved === "top" ? rect.top - GAP - bubble.height : rect.top + rect.height + GAP;
  const arrowLeft = Math.max(16, Math.min(bubble.width - 16, centerX - left));
  return { left, top: Math.max(8, top), arrowLeft, side: resolved };
}

/**
 * R13 §3:剪映式功能气泡。非模态(不 `aria-modal`、不抢焦点),`role=dialog` 名「新手引导」;
 * 锚点用轮询 + resize/scroll 跟随(锚点会随栏宽、滚动、折叠而动,300ms 一拍足够,零依赖)。
 * 动画只做一次淡入,`prefers-reduced-motion` 下由 CSS 关掉。
 */
export function Guide({ anchor, text, side, tryLabel, onTry, onDismiss, onAnchorMissing, anchorWaitMs = 2_500, counter, yieldWhilePlaying = false }: GuideProps): JSX.Element | null {
  const [target, setTarget] = useState<HTMLElement | null>(() => (typeof document === "undefined" ? null : resolveAnchor(anchor)));
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [bubble, setBubble] = useState<HTMLDivElement | null>(null);
  // Y-02:气泡和监视器画面重叠时会被原生视频层盖住,那时才让视频让位。
  // 2026-09-19 frozen-video:以前是「画出来就让位」——九条引导里多数锚在导航条 / 镜头带 /
  // 状态条上,根本没压到画面,却把原生视图整块藏掉,监视器只剩井底封面、mpv 照常放音,
  // 业主看到的就是「声音在走、画面不动」。现在按几何判:气泡矩形与画面矩形相交才登记。
  const [coversVideo, setCoversVideo] = useState(false);
  const measured = useRef<{ width: number; height: number } | null>(null);
  // 压到画面又躲不开、而画面正在放:气泡让位(不画、不登记),停下来再出。
  const yielding = coversVideo && yieldWhilePlaying;
  useOccludesPlayer(target !== null && coversVideo && !yielding);

  // 找锚点:立刻找一次,之后每拍再找(元素可能晚一步才画出来);超时通知宿主。
  useEffect(() => {
    let found = resolveAnchor(anchor);
    setTarget(found);
    let elapsed = 0;
    const timer = window.setInterval(() => {
      elapsed += POLL_MS;
      const next = resolveAnchor(anchor);
      if (next !== found) {
        found = next;
        setTarget(next);
      }
      if (next === null && elapsed >= anchorWaitMs) {
        window.clearInterval(timer);
        onAnchorMissing?.();
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [anchor, anchorWaitMs, onAnchorMissing]);

  useLayoutEffect(() => {
    if (target === null || bubble === null) {
      setPlacement(null);
      setCoversVideo(false);
      return;
    }
    const update = () => {
      const rect = target.getBoundingClientRect();
      // 让位期间(hidden)量不到尺寸:沿用上一次量到的,几何判定才不会在「藏 / 出」之间抖。
      if (bubble.offsetWidth > 0 && bubble.offsetHeight > 0) {
        measured.current = { width: bubble.offsetWidth, height: bubble.offsetHeight };
      }
      const size = measured.current ?? { width: BUBBLE_WIDTH, height: 96 };
      const video = nativeVideoRect();
      const next = placeBubble(rect, side, { width: window.innerWidth, height: window.innerHeight }, size, video);
      setPlacement(next);
      setCoversVideo(video !== null && rectsIntersect({ left: next.left, top: next.top, width: size.width, height: size.height }, video));
    };
    update();
    const timer = window.setInterval(update, POLL_MS);
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [target, bubble, side]);

  if (target === null) return null;
  // 让位期间仍挂着(hidden)—— 锚点跟随与几何判定继续跑,播放一停就原地出现。
  const style: CSSProperties | undefined = placement
    ? ({ left: placement.left, top: placement.top, "--guide-arrow-left": `${placement.arrowLeft}px` } as CSSProperties)
    : { left: 8, top: 8, visibility: "hidden" };
  return (
    <div
      role="dialog"
      aria-label="新手引导"
      className="ui-guide"
      data-teach="guide"
      data-side={placement?.side ?? side}
      style={style}
      ref={setBubble}
      hidden={yielding}
    >
      <span className="ui-guide-arrow" aria-hidden="true" />
      <div className="ui-guide-head">
        <span className="ui-guide-kicker">新手引导</span>
        {counter ? <span className="ui-guide-counter">{counter}</span> : null}
      </div>
      <p className="ui-guide-text">{text}</p>
      <div className="ui-guide-actions">
        {tryLabel && onTry ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onTry();
              onDismiss();
            }}
          >
            {tryLabel}
          </Button>
        ) : null}
        {/* R19 V-01:气泡不是主动作(不与顶栏「下一步」争同屏唯一的实心按钮),深底上用描边。 */}
        <Button variant={tryLabel && onTry ? "ghost" : "secondary"} size="sm" className="ui-guide-ok" onClick={onDismiss}>
          知道了
        </Button>
      </div>
    </div>
  );
}
