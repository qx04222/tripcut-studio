import { useEffect, useRef, useState, type JSX } from "react";

import { CLOSE_REQUESTED_EVENT, bridgeCloseRequestedEvents, confirmExit, type CloseRequestedEvent } from "../api";
import { Button } from "./ui";

/**
 * R18 车道 native / F2:关窗口时后台任务还没做完的确认。
 *
 * 后端(`src-tauri/src/exit_guard.rs`)在 `CloseRequested` 里数一遍**用户的**活儿
 * (空闲缓存清理不算),非空就 `prevent_close()` 并发 `tripcut:close-requested`。
 * 「仍要退出」调 `confirm_exit`(后端设标志位再退出,第二次事件不再拦);
 * 「继续等」只是关掉这张卡——窗口本来就没关成。
 *
 * AX:alertdialog「后台任务还没做完」;按钮「仍要退出」/「继续等」。
 */
export function ExitConfirm(): JSX.Element | null {
  const [running, setRunning] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const card = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void bridgeCloseRequestedEvents().then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    const onRequested = (event: Event) => {
      const detail = (event as CustomEvent<CloseRequestedEvent>).detail;
      setRunning(Math.max(1, Number(detail?.running ?? 1)));
    };
    window.addEventListener(CLOSE_REQUESTED_EVENT, onRequested);
    return () => {
      disposed = true;
      stop?.();
      window.removeEventListener(CLOSE_REQUESTED_EVENT, onRequested);
    };
  }, []);

  useEffect(() => {
    if (running !== null) card.current?.focus();
  }, [running]);

  if (running === null) return null;

  return (
    <div ref={card} tabIndex={-1} role="alertdialog" aria-label="后台任务还没做完" className="exit-confirm">
      <strong>{`还有 ${running} 个后台任务没做完,现在退出会中断它们`}</strong>
      <p>下次打开会从中断的地方接着做,但这一轮的进度会白跑一次。</p>
      <div className="exit-confirm-actions">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRunning(null)}>
          继续等
        </Button>
        <Button
          variant="primary"
          tone="danger"
          size="sm"
          busy={busy}
          onClick={() => {
            setBusy(true);
            // 成功的话进程就没了,没有"之后";失败了也别把窗口锁死——把卡收掉。
            void confirmExit().catch(() => {
              setBusy(false);
              setRunning(null);
            });
          }}
        >
          仍要退出
        </Button>
      </div>
    </div>
  );
}
