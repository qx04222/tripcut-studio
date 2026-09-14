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
  STALE_CLIP_COMMAND,
  playerOpen,
  playerSetViewport,
  playerStatus,
  type ClipListItem,
  type PlayerCommand,
  type PlayerStatus,
  type SelectSegment,
} from "./api";
import { PLAYER_SHORTCUTS } from "./helpContent";
import { useFocusTrap } from "./useFocusTrap";
import { rectToPlayerViewport, visibleSurfaceRect } from "./playerViewport";
import { PLAYER_VIEWPORT_REFRESH_EVENT } from "./workspace/usePlayerOcclusion";
import "./PlayerOverlay.css";

function isStaleClipCommand(reason: unknown): boolean {
  const text = reason instanceof Error ? reason.message : String(reason ?? "");
  return text.includes(STALE_CLIP_COMMAND);
}

export const STATUS_INTERVAL_MS = 80;

/**
 * V-04:mpv 的 seek 是异步的 —— 命令返回那一刻 `time-pos` 多半还是旧值,暂停时又不轮询,
 * 读数会停在旧位置直到下一条命令。seek 之后按这个节拍补读,直到位置落到目标附近
 * (半帧内)或超时;超时也把最后一次读到的状态交出去,别让读数永远停着。
 */
export const SEEK_SETTLE_POLL_MS = 40;
export const SEEK_SETTLE_MAX_POLLS = 15;

/** seek 落地判据:与目标差在半帧内(fps 无效按 30)。 */
export function seekSettled(pos: number, target: number, fps: number): boolean {
  const frame = Number.isFinite(fps) && fps > 0 ? 1 / fps : 1 / 30;
  return Math.abs(pos - target) <= frame / 2 + 1e-6;
}

/** R12 §5:一批命令是否以原生逐帧收尾 —— mpv 的 frame-step 也是异步落地,读数要等位置变了再交出去。 */
export function endsWithFrameStep(commands: readonly PlayerCommand[]): boolean {
  const last = commands[commands.length - 1];
  return last?.type === "step_fwd" || last?.type === "step_back";
}

/** 一批命令里最后一条 seek 的目标;没有 seek 返回 null。 */
export function lastSeekTarget(commands: readonly PlayerCommand[]): number | null {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index];
    if (command?.type === "seek_abs") return command.seconds;
  }
  return null;
}

/**
 * 规格 §11:拖分隔条时区域矩形每帧都在变,每一帧都去 `set_viewport` 会把
 * mpv 的渲染线程打满。120ms 防抖——静止后才落一次真正的矩形。
 */
export const VIEWPORT_DEBOUNCE_MS = 120;

/** 嵌入模式交给宿主(监视器)的通道:同一个 mpv 实例,命令与刷新都走这里。 */
export interface EmbeddedPlayerControls {
  send(commands: PlayerCommand[]): Promise<void>;
  refresh(): Promise<void>;
}

/**
 * 规格 §5:80ms 状态轮询只在「可见且播放中」跑。暂停时画面不动,每 80ms 敲一次
 * 后端纯属白烧 CPU;还没 ready 时必须继续敲,否则「正在建立链路」永远不翻页。
 */
export function shouldPollStatus(status: PlayerStatus | null, hidden: boolean): boolean {
  if (hidden) return false;
  if (!status) return true;
  if (status.phase !== "ready") return true;
  return status.paused === false;
}

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

/**
 * Z-17:帧号跟时间码同源 —— 由源时间位置 × 帧率算,不读 mpv 的 estimated-frame-number
 * (代理链路下它停在 0,真机 2.2 s 时仍写「第 0 帧」)。
 */
export function frameLabel(status: Pick<PlayerStatus, "pos" | "phase"> | null, fps: number): string {
  if (!status || status.phase !== "ready" || !Number.isFinite(status.pos)) return "";
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return `第 ${Math.floor(status.pos * rate + 1e-6)} 帧`;
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

// 区域矩形的几何(与裁切祖先求交)在 playerViewport.ts;这里保留同名导出给旧调用点。
export { rectToPlayerViewport } from "./playerViewport";

/**
 * `onStatusChange` 和 `controlsRef` 是嵌入态专用的接缝(embedded-only seams):
 * 监视器把同一个 mpv 实例嵌进中上区时,状态轮询与命令通道都要交给宿主 ——
 * 宿主的控件条读 `onStatusChange` 推来的状态、经 `controlsRef` 发命令,自己
 * 不直接调 `playerStatus`/`playerCommand`。沉浸态(默认 variant)不传这两个
 * prop,行为与它们加入前完全一致。
 */
export function PlayerOverlay({
  clip,
  onExit,
  onSegmentsChange,
  variant = "immersive",
  onRequestImmersive,
  onStatusChange,
  controlsRef,
}: {
  clip: ClipListItem;
  onExit: () => void;
  onSegmentsChange?: () => void;
  /** 默认沉浸态(旧调用点一个字不改);"embedded" 是监视器区里的同一个 mpv 实例。 */
  variant?: "immersive" | "embedded";
  /** 嵌入模式下 ⌘⏎ 的回调。 */
  onRequestImmersive?: () => void;
  /** 嵌入模式下把状态推给宿主 —— 控件条由监视器画,但状态只有一份轮询。 */
  onStatusChange?: (status: PlayerStatus | null) => void;
  /** 嵌入模式下把命令通道交给宿主,宿主不直接 `playerCommand`,否则轮询无法复位。 */
  controlsRef?: { current: EmbeddedPlayerControls | null };
}) {
  const embedded = variant === "embedded";
  const surfaceRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
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

  // O11:整个沉浸播放层是个模态,Tab 不能漏到背后的筛片页。
  // 嵌入模式不是模态 —— 它只是中上区的一块画面,抢焦点会把媒体池的键盘操作打断。
  useFocusTrap(overlayRef, !embedded);

  // R17 playfix:通道只属于「已经 player_open 成功的那条素材」。Rust 侧 player_command 排在
  // PlayerManager::open 的 operation 锁后面,换素材期间发出的命令会等 B 的新实例起来再落到
  // B 上 —— A 的 seek_abs 就这样变成 B 的起播位置。这里记「哪条素材已打开」,批次里逐条核对。
  const openedClipId = useRef<number | null>(null);

  // 卸载与「换素材」要分开:换素材只 playerOpen,绝不 playerClose 重建实例。
  // 这条 effect 声明在开流 effect 之前,卸载时它的清理先跑,旗子才来得及立。
  const unmountingRef = useRef(false);
  useEffect(() => {
    unmountingRef.current = false;
    return () => {
      unmountingRef.current = true;
    };
  }, []);

  useEffect(() => {
    statusRef.current = status;
    onStatusChange?.(status);
  }, [onStatusChange, status]);

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
        if (!embedded) overlayRef.current?.focus();
        await waitForLayout();
        const surface = surfaceRef.current;
        if (!surface || !active) return;
        const viewport = rectToPlayerViewport(visibleSurfaceRect(surface));
        if (viewport) await playerSetViewport(viewport);
        const initial = await playerOpen(clip.id as number);
        if (!active) return;
        openedClipId.current = clip.id as number;
        setStatus(initial);
        setOpening(initial.phase !== "ready");
        timer = window.setInterval(() => {
          // 规格 §5:不可见或已暂停就停表,别让静止的画面每 80ms 敲一次后端。
          const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
          if (!shouldPollStatus(statusRef.current, hidden)) return;
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
        if (!embedded) overlayRef.current?.focus();
      } catch (reason) {
        if (active) await reportFailure(reason);
      }
    };
    void start();
    return () => {
      active = false;
      openedClipId.current = null;
      if (timer !== undefined) window.clearInterval(timer);
      // 嵌入模式换素材时这条 effect 也会重跑,但那是「同一个实例换源」,
      // 只有真的卸载才关播放器 —— 否则每换一条素材就重建一次 mpv。
      if (!embedded || unmountingRef.current) void playerClose();
    };
  }, [clip.id, embedded, reportFailure]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    let active = true;
    let frame: number | null = null;
    let debounce: number | null = null;
    const commitViewport = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (!active) return;
        const viewport = rectToPlayerViewport(visibleSurfaceRect(surface));
        if (!viewport) return;
        void playerSetViewport(viewport).catch((reason) => {
          if (active) void reportFailure(reason);
        });
      });
    };
    const updateViewport = () => {
      // 120ms 防抖只用于嵌入态:监视器区里拖分隔条 / 折叠栏会连发几十次 resize,
      // 每一帧都去 set_viewport 会打满 mpv 渲染线程。沉浸态是全屏模态,resize
      // 频率低得多,行为必须与去抖引入前完全一致——同步落矩形,不等静止窗口。
      if (!embedded) {
        commitViewport();
        return;
      }
      if (debounce !== null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        debounce = null;
        commitViewport();
      }, VIEWPORT_DEBOUNCE_MS);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateViewport);
    observer?.observe(surface);
    window.addEventListener("resize", updateViewport);
    // 覆盖层收起(R9 D1)/ 舞台尺寸变了(R9 D5)时监视器广播一次:这是一次
    // 明确的、已经算好的请求,直接按帧提交,不进防抖——防抖会被别的事件源
    // 一再重置,真机上旅程页签下的矩形就是这样一直提交不出去的(P0-B)。
    window.addEventListener(PLAYER_VIEWPORT_REFRESH_EVENT, commitViewport);
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener("resize", updateViewport);
      window.removeEventListener(PLAYER_VIEWPORT_REFRESH_EVENT, commitViewport);
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (debounce !== null) window.clearTimeout(debounce);
    };
  }, [clip.id, embedded, reportFailure]);

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

  const refreshStatus = useCallback(async () => {
    try {
      const next = await playerStatus();
      if (next.phase === "error" || next.error) {
        await reportFailure(next.error ?? "播放器渲染线程已退出");
        return;
      }
      setStatus(next);
      setOpening(next.phase !== "ready");
    } catch (reason) {
      await reportFailure(reason);
    }
  }, [reportFailure]);

  // seek 之后等它落地(V-04):只把落地(或超时)那次状态交出去,中间的旧位置不上屏。
  // 代际号:新的一批命令、换素材、卸载都让还在等的旧循环退出,别对着已经不在的实例敲。
  const settleGeneration = useRef(0);
  useEffect(() => {
    return () => {
      settleGeneration.current += 1;
    };
  }, [clip.id]);
  // 按节拍补读,直到 `settled(next)` 成立或超时;超时也把最后一次读到的状态交出去。
  const settleUntil = useCallback(
    async (settled: (next: PlayerStatus) => boolean) => {
      const generation = ++settleGeneration.current;
      for (let attempt = 0; attempt < SEEK_SETTLE_MAX_POLLS; attempt += 1) {
        let next: PlayerStatus;
        try {
          next = await playerStatus();
        } catch (reason) {
          await reportFailure(reason);
          return;
        }
        if (generation !== settleGeneration.current) return;
        if (next.phase === "error" || next.error) {
          await reportFailure(next.error ?? "播放器渲染线程已退出");
          return;
        }
        const last = attempt === SEEK_SETTLE_MAX_POLLS - 1;
        if (next.phase !== "ready" || settled(next) || last) {
          setStatus(next);
          setOpening(next.phase !== "ready");
          return;
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, SEEK_SETTLE_POLL_MS));
        if (generation !== settleGeneration.current) return;
      }
    },
    [reportFailure],
  );
  const settleSeek = useCallback((target: number) => settleUntil((next) => seekSettled(next.pos, target, fps)), [fps, settleUntil]);
  // 原生逐帧之后等位置变了(半帧以上)再交出状态(R12 §5)。
  const settleStep = useCallback(
    (before: number | null) => settleUntil((next) => before === null || !seekSettled(next.pos, before, fps)),
    [fps, settleUntil],
  );

  const sendCommands = useCallback(
    async (commands: PlayerCommand[]) => {
      // 这批命令属于现在已打开的这条素材;B 的 player_open 还没回来时一条都不发,
      // 发到一半换了素材就停在那里(剩下的不发、也不为这批补读状态)。
      const owner = openedClipId.current;
      if (owner === null) return;
      const before = statusRef.current?.phase === "ready" ? statusRef.current.pos : null;
      try {
        for (const command of commands) {
          if (openedClipId.current !== owner) return;
          await playerCommand(command, owner);
        }
        if (openedClipId.current !== owner) return;
      } catch (reason) {
        // 后端按归属拒掉的旧素材命令不是故障:换源窗口里的正常淘汰,静默。
        if (isStaleClipCommand(reason)) return;
        await reportFailure(reason);
        return;
      }
      // 停表期间(暂停)发出的 play 不会被轮询看见 —— 命令之后立刻补读一次,
      // 让 paused 翻成 false,80ms 的表才重新走起来。带 seek 的一批要等 seek 落地;
      // 原生逐帧收尾的一批要等位置变了(R12 §5)。
      const target = lastSeekTarget(commands);
      if (target !== null) await settleSeek(target);
      else if (endsWithFrameStep(commands)) await settleStep(before);
      else await refreshStatus();
    },
    [refreshStatus, reportFailure, settleSeek, settleStep],
  );

  useEffect(() => {
    if (!controlsRef) return;
    controlsRef.current = { send: sendCommands, refresh: refreshStatus };
    return () => {
      controlsRef.current = null;
    };
  }, [controlsRef, refreshStatus, sendCommands]);

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

  const seekBySlider = useCallback(
    (delta: number) => {
      const current = statusRef.current;
      if (!current || current.phase !== "ready" || current.duration <= 0) return;
      void sendCommands([{ type: "seek_abs", seconds: Math.min(current.duration, Math.max(0, current.pos + delta)) }]);
    },
    [sendCommands],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const imeActive = compositionRef.current || event.isComposing || event.keyCode === 229;
      if (imeActive) {
        setComposing(true);
        return;
      }
      if (embedded) {
        // 嵌入模式只认 ⌘⏎:传输控件与 I/O 打点由监视器自己的控件条接管,
        // 单键(空格 / L / R)属于媒体池与镜头带的评级键位,这里一个都不能抢。
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onRequestImmersive?.();
        }
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
      // O11:进度条本身拿到焦点时,←/→ 由该元素自身的 onKeyDown(见下方
      // player-progress,满足 jsx-a11y/click-events-have-key-events)处理 slider
      // 语义的 1 秒定位——这里只负责不让它继续落到全局逐帧步进分支,避免重复触发。
      if ((key === "arrowleft" || key === "arrowright") && document.activeElement === progressRef.current) {
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
  }, [embedded, error, leave, onRequestImmersive, saveSegment, savingSegment, seekBySlider, sendCommands]);

  const beginComposition = (_event: CompositionEvent<HTMLDivElement>) => {
    compositionRef.current = true;
    setComposing(true);
  };
  const endComposition = (_event: CompositionEvent<HTMLDivElement>) => {
    compositionRef.current = false;
    setComposing(false);
  };

  const seekFromPointer = (event: MouseEvent<HTMLDivElement>) => {
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

  if (embedded) {
    // 嵌入模式只画画面本体:控件条、时间码、I/O 由 Monitor 的控件条画,
    // 两边各画一套会出现两条进度条却只有一个 mpv 实例。
    return (
      <div className={`player-overlay embedded${error ? " has-error" : ""}`} ref={overlayRef}>
        <div className="player-native-slot" ref={surfaceRef} aria-hidden="true">
          {opening && !error ? (
            <span className="player-opening-mark">正在建立源时间播放链路</span>
          ) : null}
        </div>
        {error ? (
          <div className="player-error" role="alert">
            <strong>播放器异常</strong>
            <p>{error}</p>
          </div>
        ) : null}
      </div>
    );
  }

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
        <div
          className="player-progress"
          ref={progressRef}
          role="slider"
          aria-label="播放进度"
          aria-valuemin={0}
          aria-valuemax={status?.duration ?? 0}
          aria-valuenow={status?.pos ?? 0}
          aria-disabled={!status || status.phase !== "ready" || status.duration <= 0}
          tabIndex={0}
          onClick={seekFromPointer}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              seekBySlider(-1);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              seekBySlider(1);
            }
          }}
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
        </div>
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
              {frameLabel(status, fps)}
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
