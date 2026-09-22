import { useCallback, useEffect, useRef, useState } from "react";

import type { ClipListItem, PlayerCommand, PlayerStatus } from "../api";
import { isAtEnd } from "./MonitorSeekBar";
import { usePlayerPrefs, writePlayerPref } from "./playerPrefs";
import { nextPoolClipId } from "./poolOrder";
import { dispatchWorkspace } from "./WorkspaceStore";

/** J「倒退」的节拍:mpv 不支持负速,按 8 fps 定时发原生 `frame-back-step`。 */
export const REWIND_TICK_MS = 125;

/** 手动换素材之后这么久内不「播完自动下一条」(V-05)。 */
export const AUTO_ADVANCE_SUPPRESS_MS = 1_000;

/** 真变速的档位(mpv `speed` 属性;原生层再夹一次 0.25–4)。L 循环 1 → 2 → 4 → 1;菜单可选 0.5。 */
export type PlaybackRate = 0.5 | 1 | 2 | 4;
export const PLAYBACK_RATES: readonly PlaybackRate[] = [0.5, 1, 2, 4];

export function nextPlaybackRate(current: PlaybackRate): PlaybackRate {
  if (current === 1) return 2;
  if (current === 2) return 4;
  return 1;
}

export function playbackRateLabel(rate: PlaybackRate, rewinding: boolean): string {
  return rewinding ? "倒退" : `×${rate}`;
}

export function clipFps(clip: Pick<ClipListItem, "fps_num" | "fps_den"> | null): number {
  if (clip && (!Number.isFinite(clip.fps_num) || !Number.isFinite(clip.fps_den))) return 30;
  if (!clip || clip.fps_num === null || clip.fps_den === null || clip.fps_den <= 0 || clip.fps_num <= 0) return 30;
  return clip.fps_num / clip.fps_den;
}

export interface MonitorTransportDeps {
  clip: ClipListItem | null;
  status: PlayerStatus | null;
  send(commands: PlayerCommand[]): Promise<void>;
  inPoint: number | null;
  outPoint: number | null;
  /** 最高分时刻(秒);素材一就绪预览帧就停在这里(设置 `ui.player.start_at_best`)。 */
  bestStart: number | null;
  /** 时刻分已经拉完(成功或失败)—— 没到齐之前不决定从哪开播。 */
  momentsLoaded: boolean;
  playthroughActive?: boolean;
}

export interface MonitorTransport {
  rate: PlaybackRate;
  rewinding: boolean;
  speedLabel: string;
  shuttle(key: "j" | "k" | "l"): void;
  /** 「×1」按钮的速度菜单:设 mpv 速度;暂停时顺带开播。 */
  setRate(rate: PlaybackRate): void;
  frame(direction: 1 | -1): void;
  nudge(seconds: number): void;
  /** 绝对定位;监视器的所有 seek 都从这里走,位置锚点才跟得上(V-04)。 */
  seekTo(seconds: number, options?: { source: "playthrough" }): Promise<boolean>;
  play(): Promise<void>;
  pause(): Promise<void>;
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
  /** R12 §5:「连播」—— 播完自动下一条,监视器上的显式开关(默认关)。 */
  autoAdvance: boolean;
  toggleAutoAdvance(): void;
}

/**
 * R11 §3 的走带逻辑,R12 §5 换成原生真变速:
 * - 变速 = `set_speed`(mpv `speed` 属性,L 循环 ×1 → ×2 → ×4 → ×1,K 停并回 ×1);
 * - 反向 = 「倒退」:mpv 不支持负速,暂停后按 8 fps 定时发原生 `step_back`,退到 0 自动停;
 * - 逐帧 = 原生 `step_fwd` / `step_back`(mpv `frame-step` / `frame-back-step`);
 * - ⇧L 循环 = 播放头越过出点就回入点(保存后由监视器调 stopLoop);
 * - 播完自动下一条(「连播」,默认关)= 顺媒体池当前可见顺序,末尾停;循环中不跳;
 * - 静音记忆 = `ui.player.muted`,素材就绪时补发一次 set_mute;
 * - 点卡片 = 预览(R12 §5):素材就绪先暂停,时刻分到齐后停在最高分时刻(每条素材只做一次)。
 */
export function useMonitorTransport({ clip, status, send, inPoint, outPoint, bestStart, momentsLoaded, playthroughActive = false }: MonitorTransportDeps): MonitorTransport {
  const prefs = usePlayerPrefs();
  const [rate, setRateState] = useState<PlaybackRate>(1);
  const [rewinding, setRewinding] = useState(false);
  const [looping, setLooping] = useState(false);
  const clipId = clip?.id ?? null;
  const ready = status?.phase === "ready" && status.clip_id === clipId;

  const latest = useRef({ status, send, inPoint, outPoint, looping, rate, rewinding, clipId });
  latest.current = { status, send, inPoint, outPoint, looping, rate, rewinding, clipId };
  // R17 playfix:每条命令都只能打在「状态里就是这条素材」的播放器上。换素材那一拍 clip 已经是
  // B、status 还是 A 的(位置是 A 停住的地方)——按位置算的 seek 若这时发出去,会穿过 Rust 侧
  // player_command 的 operation 锁落到 B 的新实例上,B 就从 A 停住的位置开始播。
  const readyStatus = useCallback((): (PlayerStatus & { phase: "ready" }) | null => {
    const current = latest.current.status;
    if (!current || current.phase !== "ready" || current.clip_id !== latest.current.clipId) return null;
    return current as PlayerStatus & { phase: "ready" };
  }, []);
  // mpv 的 `speed` 属性跨 loadfile 保留:记住最后一次发给它的值,换素材就绪时不是 1 就补发。
  const mpvRate = useRef<PlaybackRate>(1);

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
    const current = readyStatus();
    if (!current) return null;
    return anchor.current !== null && current.paused ? anchor.current : current.pos;
  }, [readyStatus]);
  // send 在 seek 落地(或等够了)之后才 resolve —— 那时状态就是真位置,锚点可以放掉;
  // 期间又发了新 seek 的话锚点已换成新目标,不动它。
  const sendAnchored = useCallback((commands: PlayerCommand[], target: number) => {
    anchor.current = target;
    return latest.current.send(commands).finally(() => {
      if (anchor.current === target) anchor.current = null;
    });
  }, []);
  const seekTo = useCallback(
    async (seconds: number, options?: { source: "playthrough" }) => {
      if (options?.source !== "playthrough") window.dispatchEvent(new Event("tripcut:manual-seek"));
      const current = readyStatus();
      if (!current) return false;
      const target = Math.min(current.duration, Math.max(0, seconds));
      await sendAnchored([{ type: "seek_abs", seconds: target }], target);
      return true;
    },
    [sendAnchored, readyStatus],
  );

  const play = useCallback(async () => {
    if (readyStatus()) await latest.current.send([{ type: "play" }]);
  }, [readyStatus]);
  const pause = useCallback(async () => {
    setRewinding(false);
    if (readyStatus()) await latest.current.send([{ type: "pause" }]);
  }, [readyStatus]);

  // 换素材:速度标签、倒退、循环、位置锚点归零(入出点由监视器自己清);mpv 侧的 speed 在就绪时补发。
  useEffect(() => {
    setRateState(1);
    setRewinding(false);
    setLooping(false);
    anchor.current = null;
  }, [clipId]);

  // 「倒退」:按 8 fps 发原生 step_back;退到头(不足一帧)自动停。
  useEffect(() => {
    if (!rewinding) return;
    const timer = window.setInterval(() => {
      const current = readyStatus();
      if (!current) return;
      if (current.pos <= 1 / fps / 2 + 1e-6) {
        setRewinding(false);
        return;
      }
      void latest.current.send([{ type: "step_back" }]);
    }, REWIND_TICK_MS);
    return () => window.clearInterval(timer);
  }, [rewinding, fps, readyStatus]);

  /** 设速度并(暂停时)开播:L 与速度菜单共用。播完再开播从头放(U-09)。 */
  const playAt = useCallback((next: PlaybackRate) => {
    const current = readyStatus();
    if (!current) return;
    setRewinding(false);
    setRateState(next);
    mpvRate.current = next;
    const commands: PlayerCommand[] = [{ type: "set_speed", speed: next }];
    if (current.paused) {
      if (isAtEnd(current)) commands.push({ type: "seek_abs", seconds: 0 });
      commands.push({ type: "play" });
    }
    void latest.current.send(commands);
  }, [readyStatus]);

  const shuttle = useCallback(
    (key: "j" | "k" | "l") => {
      const current = readyStatus();
      if (!current) return;
      const { rate: currentRate, rewinding: isRewinding } = latest.current;
      if (key === "l") {
        // 暂停 / 倒退中按 L = 从 ×1 开播;播放中 = 下一档(×1 → ×2 → ×4 → ×1)。
        playAt(current.paused || isRewinding ? 1 : nextPlaybackRate(currentRate));
        return;
      }
      if (key === "k") {
        setRewinding(false);
        setRateState(1);
        mpvRate.current = 1;
        void latest.current.send([{ type: "pause" }, { type: "set_speed", speed: 1 }]);
        return;
      }
      if (isRewinding) return;
      setRewinding(true);
      anchor.current = null;
      void latest.current.send([{ type: "pause" }]);
    },
    [playAt, readyStatus],
  );

  const setRate = useCallback((next: PlaybackRate) => playAt(next), [playAt]);

  // 逐帧走原生 frame-step / frame-back-step:mpv 自己暂停、自己算下一帧的位置,不再按
  // pos ± 1/fps 发 seek(V-04 的算错位置从根上没了);读数由通道等到位置变了再交出去。
  const frame = useCallback((direction: 1 | -1) => {
    window.dispatchEvent(new Event("tripcut:manual-seek"));
    if (!readyStatus()) return;
    setRewinding(false);
    anchor.current = null;
    void latest.current.send([{ type: direction > 0 ? "step_fwd" : "step_back" }]);
  }, [readyStatus]);

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
    if (playthroughActive || !looping || !ready || status.paused || inPoint === null || outPoint === null || outPoint <= inPoint) return;
    if (status.pos >= outPoint || status.pos < inPoint - 0.5) wrapToIn(inPoint);
  }, [looping, ready, status, inPoint, outPoint, wrapToIn, playthroughActive]);

  const toggleLoop = useCallback(() => {
    const { inPoint: currentIn, outPoint: currentOut, looping: on } = latest.current;
    if (currentIn === null || currentOut === null || currentOut <= currentIn || !readyStatus()) return;
    if (!on) {
      window.dispatchEvent(new Event("tripcut:manual-seek"));
      setRewinding(false);
      wrapToIn(currentIn);
    }
    setLooping(!on);
  }, [wrapToIn, readyStatus]);
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
    if (playthroughActive || looping || !prefs.autoAdvance || seenMidClipFor.current !== clipId) return;
    if (Date.now() - manualSelectionAt.current < AUTO_ADVANCE_SUPPRESS_MS) return;
    if (advancedFor.current === clipId) return;
    advancedFor.current = clipId;
    const next = nextPoolClipId(clipId);
    if (next === null) return;
    advancingTo.current = next;
    dispatchWorkspace({ type: "select-clip", clipId: next });
  }, [ready, clipId, status, looping, prefs.autoAdvance, playthroughActive]);

  // R12 §5:点卡片 = 预览。mpv 载入即播(player_open 把 pause 翻成 false),素材一就绪
  // 先把它停住 —— 不等时刻分,等一拍画面就跑起来了;静音记忆也在这一拍补发。
  const pausedFor = useRef<number | null>(null);
  const preparedFor = useRef<number | null>(null);
  // R17 playfix:「每条素材只做一次」按的是一次 player_open,不是 clipId —— 全屏来回会把同一条
  // 素材再开一个新实例(从 0 开始、载入即播)。播放器一离开这条的就绪态(换源 / 重开 / 出错)
  // 就把两枚旗子放掉,下次就绪再暂停、再停到最精彩处。
  useEffect(() => {
    if (ready) return;
    pausedFor.current = null;
    preparedFor.current = null;
  }, [ready]);
  useEffect(() => {
    if (!ready || clipId === null || pausedFor.current === clipId) return;
    pausedFor.current = clipId;
    const commands: PlayerCommand[] = [{ type: "pause" }];
    if (prefs.muted) commands.push({ type: "set_mute", muted: true });
    if (mpvRate.current !== 1) {
      mpvRate.current = 1;
      commands.push({ type: "set_speed", speed: 1 });
    }
    void send(commands);
  }, [ready, clipId, prefs.muted, send]);

  // 「从最精彩处」:时刻分到齐后把预览帧停在最高分时刻(每条素材只做一次);
  // 拉失败的素材 bestStart 是 null,停在首帧。开播仍由用户按空格 / 点播放。
  useEffect(() => {
    if (!ready || clipId === null || preparedFor.current === clipId) return;
    if (playthroughActive) { preparedFor.current = clipId; return; }
    if (!prefs.startAtBest) return;
    if (!momentsLoaded) return;
    preparedFor.current = clipId;
    if (bestStart !== null && bestStart > 0) void send([{ type: "seek_abs", seconds: bestStart }]);
  }, [ready, clipId, prefs.startAtBest, bestStart, momentsLoaded, send, playthroughActive]);

  const toggleAutoAdvance = useCallback(() => {
    void writePlayerPref("ui.player.auto_advance", !prefs.autoAdvance);
  }, [prefs.autoAdvance]);

  const toggleMute = useCallback(() => {
    const next = !prefs.muted;
    void writePlayerPref("ui.player.muted", next);
    void latest.current.send([{ type: "set_mute", muted: next }]);
  }, [prefs.muted]);

  return {
    rate,
    rewinding,
    speedLabel: playbackRateLabel(rate, rewinding),
    shuttle,
    setRate,
    frame,
    nudge,
    seekTo,
    play,
    pause,
    position,
    looping,
    toggleLoop,
    stopLoop,
    muted: prefs.muted,
    toggleMute,
    autoAdvance: prefs.autoAdvance,
    toggleAutoAdvance,
  };
}
