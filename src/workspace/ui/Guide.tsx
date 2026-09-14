import { useEffect, useLayoutEffect, useState, type CSSProperties, type JSX, type RefObject } from "react";

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
}

const POLL_MS = 300;
const GAP = 10;
const BUBBLE_WIDTH = 300;

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

/** 纯几何:气泡贴在锚点上方 / 下方,水平居中并夹在窗内;箭头指回锚点中心。 */
export function placeBubble(
  rect: { left: number; top: number; width: number; height: number },
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
export function Guide({ anchor, text, side, tryLabel, onTry, onDismiss, onAnchorMissing, anchorWaitMs = 2_500, counter }: GuideProps): JSX.Element | null {
  const [target, setTarget] = useState<HTMLElement | null>(() => (typeof document === "undefined" ? null : resolveAnchor(anchor)));
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [bubble, setBubble] = useState<HTMLDivElement | null>(null);
  // Y-02:气泡只要和监视器画面重叠就会被原生视频层盖住 —— 画出来的时候让视频让位(比算几何简单)。
  useOccludesPlayer(target !== null);

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
      return;
    }
    const update = () => {
      const rect = target.getBoundingClientRect();
      const size = { width: bubble.offsetWidth || BUBBLE_WIDTH, height: bubble.offsetHeight || 96 };
      setPlacement(placeBubble(rect, side, { width: window.innerWidth, height: window.innerHeight }, size));
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
  const style: CSSProperties | undefined = placement
    ? ({ left: placement.left, top: placement.top, "--guide-arrow-left": `${placement.arrowLeft}px` } as CSSProperties)
    : { left: 8, top: 8, visibility: "hidden" };
  return (
    <div
      role="dialog"
      aria-label="新手引导"
      className="ui-guide"
      data-side={placement?.side ?? side}
      style={style}
      ref={setBubble}
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
            variant="primary"
            size="sm"
            onClick={() => {
              onTry();
              onDismiss();
            }}
          >
            {tryLabel}
          </Button>
        ) : null}
        <Button variant={tryLabel && onTry ? "ghost" : "primary"} size="sm" className="ui-guide-ok" onClick={onDismiss}>
          知道了
        </Button>
      </div>
    </div>
  );
}
