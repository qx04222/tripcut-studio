import { useCallback, useEffect, useRef, useState } from "react";

import type { ClipListItem, PlayerCommand, PlayerStatus } from "../api";
import { isAtEnd } from "./MonitorSeekBar";
import { usePlayerPrefs, writePlayerPref } from "./playerPrefs";
import { nextPoolClipId } from "./poolOrder";
import { dispatchWorkspace } from "./WorkspaceStore";

/** 变速 / 反向的「假走带」节拍:每 200ms 一次 seek_abs。播放器通道没有 set_speed,只能这样。 */
export const SHUTTLE_TICK_MS = 200;

/** 手动换素材之后这么久内不「播完自动下一条」(V-05)。 */
export const AUTO_ADVANCE_SUPPRESS_MS = 1_000;

/** L 依次 1× → 2× → 4×;J 依次 −1× → −2× → −4×;K 归零。 */
export type ShuttleSpeed = -4 | -2 | -1 | 0 | 1 | 2 | 4;

export function nextShuttleSpeed(current: ShuttleSpeed, key: "j" | "k" | "l"): ShuttleSpeed {
  if (key === "k") return 0;
  if (key === "l") return current <= 0 ? 1 : current === 1 ? 2 : 4;
  return current >= 0 ? -1 : current === -1 ? -2 : -4;
}

export function shuttleSpeedLabel(speed: ShuttleSpeed): string {
  if (speed === 0 || speed === 1) return "×1";
  return speed < 0 ? `◀×${-speed}` : `×${speed}`;
}

export function clipFps(clip: Pick<ClipListItem, "fps_num" | "fps_den"> | null): number {
  if (!clip || clip.fps_num === null || clip.fps_den === null || clip.fps_den <= 0 || clip.fps_num <= 0) return 30;
  return clip.fps_num / clip.fps_den;
}

export interface MonitorTransportDeps {
  clip: ClipListItem | null;
  status: PlayerStatus | null;
  send(commands: PlayerCommand[]): Promise<void>;
  inPoint: number | null;
  outPoint: number | null;
  /** 最高分时刻(秒);素材一就绪就从这里开播(设置 `ui.player.start_at_best`)。 */
  bestStart: number | null;
  /** 时刻分已经拉完(成功或失败)—— 没到齐之前不决定从哪开播。 */
  momentsLoaded: boolean;
}

export interface MonitorTransport {
  speed: ShuttleSpeed;
  speedLabel: string;
  shuttle(key: "j" | "k" | "l"): void;
  frame(direction: 1 | -1): void;
  nudge(seconds: number): void;
  /** 绝对定位;监视器的所有 seek 都从这里走,位置锚点才跟得上(V-04)。 */
  seekTo(seconds: number): void;
  /**
   * 「现在在哪」:暂停态下刚发出的 seek 还没落地时,状态里的 pos 是旧的 —— 以最后一次
   * 要去的位置为准(打入出点、逐帧都按它算);播放中或 seek 已落地就是状态里的 pos。
   * 没就绪返回 null。
   */
  position(): number | null;
  looping: boolean;
  toggleLoop(): void;
  stopLoop(): void;
  muted: boolean;
  toggleMute(): void;
}

/**
 * R11 §3 的走带逻辑,全部只用既有 `player_*` 命令:
 * - 变速 / 反向 = 暂停 + 定时 seek_abs(通道没有 set_speed);到头 / 到尾自动归零;
 * - 逐帧 = 暂停 + seek_abs(pos ± 1/fps);
 * - ⇧L 循环 = 播放头越过出点就回入点(保存后由监视器调 stopLoop);
 * - 播完自动下一条 = 顺媒体池当前可见顺序,末尾停;循环中不跳;
 * - 静音记忆 = `ui.player.muted`,素材就绪时补发一次 set_mute;
 * - 从最高分时刻开播 = 素材就绪 + 时刻分到齐后 seek 一次(每条素材只做一次)。
 */
export function useMonitorTransport({ clip, status, send, inPoint, outPoint, bestStart, momentsLoaded }: MonitorTransportDeps): MonitorTransport {
  const prefs = usePlayerPrefs();
  const [speed, setSpeed] = useState<ShuttleSpeed>(0);
  const [looping, setLooping] = useState(false);
  const clipId = clip?.id ?? null;
  const ready = status?.phase === "ready" && status.clip_id === clipId;

  const latest = useRef({ status, send, inPoint, outPoint, looping, speed });
  latest.current = { status, send, inPoint, outPoint, looping, speed };

  // V-04:暂停态 seek 的位置锚点。mpv 的 seek 异步落地,命令回来时 status.pos 多半还是旧值;
  // 连按 . 或 ⌥→ 再按 I 都不能拿旧值算,所以记住「最后要去的位置」,状态追上(半帧内)或
  // 开始播放就放掉。
  const anchor = useRef<number | null>(null);
  const fps = clipFps(clip);
  useEffect(() => {
    if (anchor.current === null || !status || status.phase !== "ready") return;
    if (!status.paused || Math.abs(status.pos - anchor.current) <= 1 / fps / 2 + 1e-6) anchor.current = null;
  }, [status, fps]);
  const position = useCallback((): number | null => {
    const current = latest.current.status;
    if (!current || current.phase !== "ready") return null;
    return anchor.current !== null && current.paused ? anchor.current : current.pos;
  }, []);
  // send 在 seek 落地(或等够了)之后才 resolve —— 那时状态就是真位置,锚点可以放掉;
  // 期间又发了新 seek 的话锚点已换成新目标,不动它。
  const sendAnchored = useCallback((commands: PlayerCommand[], target: number) => {
    anchor.current = target;
    void latest.current.send(commands).finally(() => {
      if (anchor.current === target) anchor.current = null;
    });
  }, []);
  const seekTo = useCallback(
    (seconds: number) => {
      const current = latest.current.status;
      if (!current || current.phase !== "ready") return;
      const target = Math.min(current.duration, Math.max(0, seconds));
      sendAnchored([{ type: "seek_abs", seconds: target }], target);
    },
    [sendAnchored],
  );

  // 换素材:变速、循环、位置锚点归零(入出点由监视器自己清)。
  useEffect(() => {
    setSpeed(0);
    setLooping(false);
    anchor.current = null;
  }, [clipId]);

  // 用户按了播放 / 暂停按钮(不经 shuttle):speed 跟着实际 paused 走,别让 ×2 的标签留在暂停的画面上。
  useEffect(() => {
    if (!status || status.phase !== "ready") return;
    if (status.paused && speed === 1) setSpeed(0);
    if (!status.paused && speed === 0) setSpeed(1);
  }, [status, speed]);

  // 变速 / 反向的假走带。
  useEffect(() => {
    if (speed === 0 || speed === 1) return;
    const timer = window.setInterval(() => {
      const current = latest.current.status;
      if (!current || current.phase !== "ready") return;
      const target = current.pos + speed * (SHUTTLE_TICK_MS / 1000);
      if (target <= 0 || target >= current.duration) {
        void latest.current.send([{ type: "seek_abs", seconds: Math.min(current.duration, Math.max(0, target)) }]);
        setSpeed(0);
        return;
      }
      void latest.current.send([{ type: "seek_abs", seconds: target }]);
    }, SHUTTLE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [speed]);

  const shuttle = useCallback(
    (key: "j" | "k" | "l") => {
      const current = latest.current.status;
      if (!current || current.phase !== "ready") return;
      const next = nextShuttleSpeed(latest.current.speed, key);
      setSpeed(next);
      if (next === 1) {
        void latest.current.send(isAtEnd(current) ? [{ type: "seek_abs", seconds: 0 }, { type: "play" }] : [{ type: "play" }]);
      } else if (next === 0) {
        void latest.current.send([{ type: "pause" }]);
      } else if (next === -1) {
        // 第一下 J:暂停并先退一秒(沉浸态同一张表),然后由假走带继续倒着走。
        void latest.current.send([{ type: "pause" }, { type: "seek_abs", seconds: Math.max(0, current.pos - 1) }]);
      } else if (!current.paused) {
        void latest.current.send([{ type: "pause" }]);
      }
    },
    [],
  );

  const frame = useCallback(
    (direction: 1 | -1) => {
      const current = latest.current.status;
      const from = position();
      if (!current || current.phase !== "ready" || from === null) return;
      const step = 1 / fps;
      // 1/25 = 0.04 在浮点里是 12.540000000000001;按毫秒取整,别把脏尾巴发给播放器。
      const target = Math.round(Math.min(current.duration, Math.max(0, from + direction * step)) * 1000) / 1000;
      setSpeed(0);
      sendAnchored([{ type: "pause" }, { type: "seek_abs", seconds: target }], target);
    },
    [fps, position, sendAnchored],
  );

  const nudge = useCallback(
    (seconds: number) => {
      const from = position();
      if (from !== null) seekTo(from + seconds);
    },
    [position, seekTo],
  );

  // ⇧L 循环:越过出点回入点。只在入出点齐全、且真的在播时生效;一次回绕在命令
  // 落地(send 末尾会补读状态)之前不再发第二次 —— 否则旧状态还停在出点外,effect 会连发。
  const wrapping = useRef(false);
  const wrapToIn = useCallback(
    (inSeconds: number) => {
      if (wrapping.current) return;
      wrapping.current = true;
      void latest.current
        .send([{ type: "seek_abs", seconds: inSeconds }, { type: "play" }])
        .finally(() => {
          wrapping.current = false;
        });
    },
    [],
  );
  useEffect(() => {
    if (!looping || !status || status.phase !== "ready" || status.paused || inPoint === null || outPoint === null || outPoint <= inPoint) return;
    if (status.pos >= outPoint || status.pos < inPoint - 0.5) wrapToIn(inPoint);
  }, [looping, status, inPoint, outPoint, wrapToIn]);

  const toggleLoop = useCallback(() => {
    const { inPoint: currentIn, outPoint: currentOut, status: current, looping: on } = latest.current;
    if (currentIn === null || currentOut === null || currentOut <= currentIn || !current || current.phase !== "ready") return;
    if (!on) {
      setSpeed(1);
      wrapToIn(currentIn);
    }
    setLooping(!on);
  }, [wrapToIn]);
  const stopLoop = useCallback(() => setLooping(false), []);

  // 播完自动下一条:同一条素材的「到尾」只处理一次。
  // V-05:换素材后第一份状态里的 pos 可能还是上一条的片尾(播放器换源、状态回写有先后),
  // 不能拿它当「这条播完了」——否则用户点一张卡,选中就一路跑走。两道闸:
  // (1) 只有先看见这条素材在片中(不在片尾)播过,片尾才算数;
  // (2) 手动换素材(不是自己接力过去的)之后 1 s 内不接力。
  const advancedFor = useRef<number | null>(null);
  const seenMidClipFor = useRef<number | null>(null);
  const advancingTo = useRef<number | null>(null);
  const manualSelectionAt = useRef<number>(0);
  const selectionSeen = useRef(false);
  useEffect(() => {
    if (advancingTo.current === clipId) {
      advancingTo.current = null;
      manualSelectionAt.current = 0;
    } else if (selectionSeen.current) {
      // 挂载时带着的选中不算「刚点的」;之后每次不是自己接力过去的换素材都算。
      manualSelectionAt.current = Date.now();
    }
    if (clipId !== null) selectionSeen.current = true;
  }, [clipId]);
  useEffect(() => {
    if (!ready || clipId === null) return;
    if (!isAtEnd(status)) {
      advancedFor.current = null;
      seenMidClipFor.current = clipId;
      return;
    }
    if (looping || !prefs.autoAdvance || seenMidClipFor.current !== clipId) return;
    if (Date.now() - manualSelectionAt.current < AUTO_ADVANCE_SUPPRESS_MS) return;
    if (advancedFor.current === clipId) return;
    advancedFor.current = clipId;
    const next = nextPoolClipId(clipId);
    if (next === null) return;
    advancingTo.current = next;
    dispatchWorkspace({ type: "select-clip", clipId: next });
  }, [ready, clipId, status, looping, prefs.autoAdvance]);

  // 静音记忆 + 从最高分时刻开播:每条素材就绪后各做一次。
  const preparedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!ready || clipId === null || preparedFor.current === clipId) return;
    // 时刻分还没拉完就等(到齐后 effect 会重跑);拉失败的素材 bestStart 是 null,从 0 开始。
    if (prefs.startAtBest && !momentsLoaded) return;
    preparedFor.current = clipId;
    const commands: PlayerCommand[] = [];
    if (prefs.muted) commands.push({ type: "set_mute", muted: true });
    if (prefs.startAtBest && bestStart !== null && bestStart > 0) commands.push({ type: "seek_abs", seconds: bestStart });
    if (commands.length > 0) void send(commands);
  }, [ready, clipId, prefs.muted, prefs.startAtBest, bestStart, momentsLoaded, send]);

  const toggleMute = useCallback(() => {
    const next = !prefs.muted;
    void writePlayerPref("ui.player.muted", next);
    void latest.current.send([{ type: "set_mute", muted: next }]);
  }, [prefs.muted]);

  return {
    speed,
    speedLabel: shuttleSpeedLabel(speed),
    shuttle,
    frame,
    nudge,
    seekTo,
    position,
    looping,
    toggleLoop,
    stopLoop,
    muted: prefs.muted,
    toggleMute,
  };
}
