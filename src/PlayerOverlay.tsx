import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CompositionEvent,
  type MouseEvent,
} from "react";

import {
  createSelectSegment,
  listSelectSegments,
  playerClose,
  playerCommand,
  playerOpen,
  playerSetViewport,
  playerStatus,
  type ClipListItem,
  type PlayerCommand,
  type PlayerStatus,
  type SelectSegment,
} from "./api";
import { PLAYER_SHORTCUTS } from "./helpContent";
import "./PlayerOverlay.css";

const STATUS_INTERVAL_MS = 80;

export function formatTimecode(seconds: number, _fps: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const totalMilliseconds = Math.floor(safeSeconds * 1_000 + 1e-6);
  const whole = Math.floor(totalMilliseconds / 1_000);
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const secs = whole % 60;
  const milliseconds = totalMilliseconds % 1_000;
  return `${[hours, minutes, secs]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":")}.${milliseconds.toString().padStart(3, "0")}`;
}

export function playerCommandsForKey(
  key: string,
  status: PlayerStatus,
  composing: boolean,
): PlayerCommand[] | null {
  if (composing) return null;
  switch (key.toLowerCase()) {
    case " ":
    case "spacebar":
      return [{ type: status.paused ? "play" : "pause" }];
    case "j":
      return [
        { type: "pause" },
        { type: "seek_abs", seconds: Math.max(0, status.pos - 1) },
      ];
    case "k":
      return [{ type: "pause" }];
    case "l":
      return [{ type: "play" }];
    case "arrowleft":
      return [{ type: "step_back" }];
    case "arrowright":
      return [{ type: "step_fwd" }];
    default:
      return null;
  }
}

function clipFps(clip: ClipListItem): number {
  if (clip.fps_num === null || clip.fps_den === null || clip.fps_den <= 0) return 30;
  return clip.fps_num / clip.fps_den;
}

const LAYOUT_FALLBACK_MS = 100;

export function waitForLayout(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fallback = window.setTimeout(finish, LAYOUT_FALLBACK_MS);
    window.requestAnimationFrame(() => {
      window.clearTimeout(fallback);
      finish();
    });
  });
}

export function rectToPlayerViewport(rect: DOMRect): {
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
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

export function PlayerOverlay({
  clip,
  onExit,
  onSegmentsChange,
}: {
  clip: ClipListItem;
  onExit: () => void;
  onSegmentsChange?: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<PlayerStatus | null>(null);
  const compositionRef = useRef(false);
  const closingRef = useRef(false);
  const [status, setStatus] = useState<PlayerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(true);
  const [composing, setComposing] = useState(false);
  const [segments, setSegments] = useState<SelectSegment[]>([]);
  const [inPoint, setInPoint] = useState<number | null>(null);
  const [outPoint, setOutPoint] = useState<number | null>(null);
  const [segmentNotice, setSegmentNotice] = useState<string | null>(null);
  const [savingSegment, setSavingSegment] = useState(false);
  const fps = clipFps(clip);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const leave = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    try {
      await playerClose();
    } finally {
      onExit();
    }
  }, [onExit]);

  const reportFailure = useCallback(async (reason: unknown) => {
    const detail = String(reason).replace(/^Error:\s*/, "");
    try {
      await playerClose();
    } catch {
      // The visible failure is the original player error; close is best-effort.
    }
    setOpening(false);
    setError(detail);
  }, []);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const start = async () => {
      try {
        overlayRef.current?.focus();
        await waitForLayout();
        const surface = surfaceRef.current;
        if (!surface || !active) return;
        const viewport = rectToPlayerViewport(surface.getBoundingClientRect());
        if (viewport) await playerSetViewport(viewport);
        const initial = await playerOpen(clip.id as number);
        if (!active) return;
        setStatus(initial);
        setOpening(initial.phase !== "ready");
        timer = window.setInterval(() => {
          void playerStatus()
            .then((next) => {
              if (!active) return;
              if (next.phase === "error" || next.error) {
                void reportFailure(next.error ?? "播放器渲染线程已退出");
                return;
              }
              setStatus(next);
              setOpening(next.phase !== "ready");
            })
            .catch((reason) => {
              if (active) void reportFailure(reason);
            });
        }, STATUS_INTERVAL_MS);
        overlayRef.current?.focus();
      } catch (reason) {
        if (active) await reportFailure(reason);
      }
    };
    void start();
    return () => {
      active = false;
      if (timer !== undefined) window.clearInterval(timer);
      void playerClose();
    };
  }, [clip.id, reportFailure]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    let active = true;
    let frame: number | null = null;
    const updateViewport = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (!active) return;
        const viewport = rectToPlayerViewport(surface.getBoundingClientRect());
        if (!viewport) return;
        void playerSetViewport(viewport).catch((reason) => {
          if (active) void reportFailure(reason);
        });
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateViewport);
    observer?.observe(surface);
    window.addEventListener("resize", updateViewport);
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener("resize", updateViewport);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [clip.id, reportFailure]);

  useEffect(() => {
    let active = true;
    void listSelectSegments(clip.id as number)
      .then((items) => {
        if (active) setSegments(items);
      })
      .catch((reason) => {
        if (active) setSegmentNotice(`精选段未能载入：${String(reason)}`);
      });
    return () => {
      active = false;
    };
  }, [clip.id]);

  const sendCommands = useCallback(
    async (commands: PlayerCommand[]) => {
      try {
        for (const command of commands) await playerCommand(command);
      } catch (reason) {
        await reportFailure(reason);
      }
    },
    [reportFailure],
  );

  const saveSegment = useCallback(async () => {
    if (inPoint === null || outPoint === null) {
      setSegmentNotice("请先用 I / O 设置完整入出点");
      return;
    }
    if (outPoint <= inPoint) {
      setSegmentNotice("出点必须晚于入点");
      return;
    }
    setSavingSegment(true);
    setSegmentNotice(null);
    try {
      const created = await createSelectSegment(
        clip.id as number,
        inPoint,
        outPoint,
      );
      setSegments((items) => [...items, created].sort((left, right) =>
        left.in_ticks - right.in_ticks || left.id - right.id
      ));
      setSegmentNotice("精选段已保存");
      setInPoint(null);
      setOutPoint(null);
      onSegmentsChange?.();
    } catch (reason) {
      setSegmentNotice(`精选段未保存：${String(reason).replace(/^Error:\s*/, "")}`);
    } finally {
      setSavingSegment(false);
    }
  }, [clip.id, inPoint, onSegmentsChange, outPoint]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const imeActive = compositionRef.current || event.isComposing || event.keyCode === 229;
      if (imeActive) {
        setComposing(true);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        void leave();
        return;
      }
      const current = statusRef.current;
      if (!current || current.phase !== "ready" || error) return;
      // 用物理键 code 判定:中文输入法会把字母键吃成候选(event.key 变 Process),
      // code 不受 IME 影响,剪辑快捷键无需切输入法。
      const code = event.code;
      const key = code === "KeyI" ? "i"
        : code === "KeyO" ? "o"
        : code === "KeyS" ? "s"
        : code === "KeyJ" ? "j"
        : code === "KeyK" ? "k"
        : code === "KeyL" ? "l"
        : event.key.toLowerCase();
      if (key === "i") {
        event.preventDefault();
        const next = Math.min(current.duration, Math.max(0, current.pos));
        setInPoint(next);
        setOutPoint((existing) => existing !== null && existing <= next ? null : existing);
        setSegmentNotice("已设置入点");
        return;
      }
      if (key === "o") {
        event.preventDefault();
        setOutPoint(Math.min(current.duration, Math.max(0, current.pos)));
        setSegmentNotice("已设置出点");
        return;
      }
      if (key === "s") {
        event.preventDefault();
        if (!savingSegment) void saveSegment();
        return;
      }
      const commands = playerCommandsForKey(
        key,
        current,
        false,
      );
      if (!commands) return;
      event.preventDefault();
      void sendCommands(commands);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [error, leave, saveSegment, savingSegment, sendCommands]);

  const beginComposition = (_event: CompositionEvent<HTMLDivElement>) => {
    compositionRef.current = true;
    setComposing(true);
  };
  const endComposition = (_event: CompositionEvent<HTMLDivElement>) => {
    compositionRef.current = false;
    setComposing(false);
  };

  const seekFromPointer = (event: MouseEvent<HTMLButtonElement>) => {
    const current = statusRef.current;
    if (!current || current.phase !== "ready" || current.duration <= 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    void sendCommands([{ type: "seek_abs", seconds: ratio * current.duration }]);
  };

  const progress = status && status.duration > 0
    ? Math.min(100, Math.max(0, (status.pos / status.duration) * 100))
    : 0;
  const markedDuration = inPoint !== null && outPoint !== null && outPoint > inPoint
    ? outPoint - inPoint
    : null;

  return (
    <div
      className={`player-overlay${error ? " has-error" : ""}`}
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${clip.file_name} 沉浸播放`}
      tabIndex={-1}
      onCompositionStart={beginComposition}
      onCompositionEnd={endComposition}
    >
      <div className="player-native-slot" ref={surfaceRef} aria-hidden="true">
        {opening ? <span className="player-opening-mark">正在建立源时间播放链路</span> : null}
      </div>

      {error ? (
        <div className="player-error" role="alert">
          <span>播放器离线</span>
          <strong>播放器异常，已退出沉浸态</strong>
          <p>{error}</p>
          <button type="button" onClick={onExit}>返回筛片</button>
        </div>
      ) : null}

      <div className="player-controlbar">
        <button
          className="player-progress"
          type="button"
          aria-label="点击定位播放位置"
          onClick={seekFromPointer}
          disabled={!status || status.phase !== "ready" || status.duration <= 0}
        >
          <span className="player-progress-fill" style={{ width: `${progress}%` }} />
          {status && status.duration > 0
            ? segments.map((segment) => {
                const start = segment.in_ticks * segment.tb_num / segment.tb_den;
                const end = segment.out_ticks * segment.tb_num / segment.tb_den;
                return (
                  <span
                    className="player-segment-marker"
                    style={{
                      left: `${Math.max(0, Math.min(100, start / status.duration * 100))}%`,
                      width: `${Math.max(0.2, Math.min(100, (end - start) / status.duration * 100))}%`,
                    }}
                    key={segment.id}
                  />
                );
              })
            : null}
          {status && status.duration > 0 && inPoint !== null ? (
            <span
              className="player-draft-marker"
              style={{ left: `${Math.min(100, inPoint / status.duration * 100)}%` }}
            />
          ) : null}
        </button>
        <div className="player-transport">
          <button
            className="player-play-button"
            type="button"
            onClick={() => void sendCommands([{ type: status?.paused === false ? "pause" : "play" }])}
            disabled={!status || opening}
            aria-label={status?.paused === false ? "暂停" : "播放"}
          >
            {status?.paused === false ? "Ⅱ" : "▶"}
          </button>
          <div className="player-timecode" aria-label="已播放时间 / 总时长">
            <strong>{formatTimecode(status?.pos ?? 0, fps)}</strong>
            <span>/ {formatTimecode(status?.duration ?? 0, fps)}</span>
          </div>
          <div className="player-inout" aria-live="polite">
            <span>
              <kbd>I</kbd> {inPoint === null ? "—" : formatTimecode(inPoint, fps)}
            </span>
            <span>
              <kbd>O</kbd> {outPoint === null ? "—" : formatTimecode(outPoint, fps)}
            </span>
            <strong>
              {markedDuration === null ? "待打点" : `时长 ${formatTimecode(markedDuration, fps)}`}
            </strong>
            <small>{segmentNotice ?? `${segments.length} 段已保存`}</small>
          </div>
          <div className="player-clip-meta">
            <strong title={clip.file_name}>{clip.file_name}</strong>
            <span>
              {status?.frame === null || status?.frame === undefined ? "" : `第 ${status.frame} 帧`}
              {status?.seek_p95_ms === null || status?.seek_p95_ms === undefined
                ? ""
                : ` · 精确定位 ${status.seek_p95_ms.toFixed(0)} 毫秒`}
            </span>
          </div>
          <div
            className={`player-shortcuts${composing ? " disabled" : ""}`}
            aria-label="播放快捷键"
            aria-disabled={composing}
          >
            {PLAYER_SHORTCUTS.filter((shortcut) => shortcut.id !== "exit-player").map(
              (shortcut) => (
                <span key={shortcut.id}>
                  {shortcut.keys.map((key) => <kbd key={key}>{key}</kbd>)}
                  {shortcut.action}
                </span>
              ),
            )}
          </div>
          {composing ? (
            <div className="player-ime-state" role="status">
              <span aria-hidden="true" />
              中文输入法组合中，单键播放已暂停
            </div>
          ) : null}
          <button className="player-exit" type="button" onClick={() => void leave()}>
            <kbd>Esc</kbd>
            返回
          </button>
        </div>
      </div>
    </div>
  );
}
