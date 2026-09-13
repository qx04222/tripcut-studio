import { useCallback, useEffect, useRef, useState, type ChangeEvent, type JSX } from "react";

import type { PlayerStatus } from "../api";

/** 拖动中 seek 命令的节流间隔:mpv 每次 seek 都要重建解码位置,80ms 状态轮询之外别再更密。 */
export const SEEK_THROTTLE_MS = 120;

/**
 * 「播到尾」的判定余量。mpv keep-open 停在最后一帧时 time-pos 会比 duration 少一帧
 * 上下(30p 是 33ms),EndFile 事件又把它抹平成 duration;0.2 秒够盖住这两种,又不至于
 * 把「暂停在结尾前半秒」误判成播完。
 */
export const END_EPSILON_SECONDS = 0.2;

export function isAtEnd(status: PlayerStatus | null): boolean {
  if (!status || status.phase !== "ready" || status.duration <= 0) return false;
  return status.pos >= status.duration - END_EPSILON_SECONDS;
}

export interface MonitorSeekBarProps {
  status: PlayerStatus | null;
  inPoint: number | null;
  outPoint: number | null;
  onSeek(seconds: number): void;
}

/**
 * 监视器传输条上的可拖 seek bar(U-09)。原生 `<input type="range">`:拖动、点击、
 * 左右键都是浏览器给的,AX 角色天然是 slider。只发 `seek_abs`,不碰播放器实例。
 *
 * 拖动期间用本地值画,不让 80ms 的状态轮询把拇指拉回去;seek 命令按 120ms 节流,
 * 松手时把最终值再发一次(节流窗口里最后那一下不能丢)。键盘左右键与点击轨道
 * 没有 pointerdown→拖动这段过程,一次一发,不节流。
 */
export function MonitorSeekBar({ status, inPoint, outPoint, onSeek }: MonitorSeekBarProps): JSX.Element {
  const ready = status?.phase === "ready" && status.duration > 0;
  const duration = ready ? status.duration : 0;
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const throttle = useRef<{ timer: number | null; pending: number | null; last: number }>({
    timer: null,
    pending: null,
    last: 0,
  });

  useEffect(() => {
    const box = throttle.current;
    return () => {
      if (box.timer !== null) window.clearTimeout(box.timer);
    };
  }, []);

  const flush = useCallback(() => {
    const box = throttle.current;
    box.timer = null;
    if (box.pending === null) return;
    const seconds = box.pending;
    box.pending = null;
    box.last = Date.now();
    onSeek(seconds);
  }, [onSeek]);

  const seekThrottled = useCallback(
    (seconds: number) => {
      const box = throttle.current;
      box.pending = seconds;
      if (box.timer !== null) return;
      const elapsed = Date.now() - box.last;
      if (elapsed >= SEEK_THROTTLE_MS) {
        flush();
        return;
      }
      box.timer = window.setTimeout(flush, SEEK_THROTTLE_MS - elapsed);
    },
    [flush],
  );

  // React 的 onChange 同时吃原生 input 与 change(按值去重),拖动与键盘都从这里进。
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!ready) return;
    const seconds = Number(event.currentTarget.value);
    if (!Number.isFinite(seconds)) return;
    if (scrubbing !== null) {
      setScrubbing(seconds);
      seekThrottled(seconds);
      return;
    }
    // 不是指针拖动(键盘左右键、点击轨道):一次一发。
    onSeek(seconds);
  };

  const endScrub = () => {
    if (scrubbing === null) return;
    const box = throttle.current;
    if (box.timer !== null) {
      window.clearTimeout(box.timer);
      box.timer = null;
    }
    if (box.pending !== null) flush();
    setScrubbing(null);
  };

  const pos = ready && status ? status.pos : 0;
  const value = scrubbing ?? Math.min(duration, Math.max(0, pos));
  const pct = (seconds: number) => `${duration > 0 ? Math.min(100, Math.max(0, (seconds / duration) * 100)) : 0}%`;

  return (
    <span className={`monitor-seek-track${scrubbing !== null ? " scrubbing" : ""}`}>
      {/* 入出点区间画在轨道底下,纯装饰;数据在入点/出点按钮里。 */}
      {inPoint !== null && duration > 0 ? (
        <span
          className="monitor-seek-range"
          aria-hidden="true"
          style={{ left: pct(inPoint), width: outPoint === null ? "2px" : `calc(${pct(outPoint)} - ${pct(inPoint)})` }}
        />
      ) : null}
      <span className="monitor-seek-fill" aria-hidden="true" style={{ width: pct(value) }} />
      <input
        type="range"
        className="monitor-seek-input"
        aria-label="播放位置"
        min={0}
        max={duration}
        step={0.1}
        value={value}
        disabled={!ready}
        onPointerDown={() => {
          if (ready) setScrubbing(value);
        }}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
        onLostPointerCapture={endScrub}
        onChange={onChange}
      />
    </span>
  );
}
