import type { JSX } from "react";

import { formatTimecode } from "../PlayerOverlay";
import type { ClipListItem, PlayerStatus } from "../api";
import { Button, Kbd, Toolbar } from "./ui";

export interface MonitorControlsProps {
  clip: ClipListItem;
  status: PlayerStatus | null;
  inPoint: number | null;
  outPoint: number | null;
  notice: string | null;
  saving: boolean;
  muted: boolean;
  onPlayPause(): void;
  onNudge(seconds: -1 | 1): void;
  onToggleMute(): void;
  onMarkIn(): void;
  onMarkOut(): void;
  onSaveSegment(): void;
  onRequestImmersive(): void;
}

function clipFps(clip: ClipListItem): number {
  if (clip.fps_num === null || clip.fps_den === null || clip.fps_den <= 0) return 30;
  return clip.fps_num / clip.fps_den;
}

/**
 * 监视器的传输条(规格 §3.6,形态按 C 稿的单一分组条):一条 framed Toolbar 里依次是
 * 走带(后退一秒 / 播放 / 前进一秒 / 速度 / 音量)· 等宽时间码 · 打点(入点 I / 出点 O /
 * 保存片段)· 状态字 · 全屏。它不自己开播放器 —— 所有命令都经由 `Monitor` 手上的
 * 嵌入通道发给同一个 mpv 实例(规格 §3.2)。AX 名与 R8 一字不差,图标全是装饰。
 */
export function MonitorControls({
  clip,
  status,
  inPoint,
  outPoint,
  notice,
  saving,
  muted,
  onPlayPause,
  onNudge,
  onToggleMute,
  onMarkIn,
  onMarkOut,
  onSaveSegment,
  onRequestImmersive,
}: MonitorControlsProps): JSX.Element {
  const fps = clipFps(clip);
  const ready = status?.phase === "ready";
  const playing = status?.paused === false;
  const marked = inPoint !== null && outPoint !== null && outPoint > inPoint
    ? outPoint - inPoint
    : null;

  return (
    <div className="monitor-controls">
      <Toolbar ariaLabel="走带与打点" className="ui-toolbar--framed monitor-transport">
        <Button
          variant="icon"
          icon="prev"
          aria-label="后退一秒"
          title="后退一秒"
          disabled={!ready}
          onClick={() => onNudge(-1)}
        />
        <Button
          variant="icon"
          icon={playing ? "pause" : "play"}
          className="monitor-play"
          aria-label={playing ? "暂停" : "播放"}
          title={playing ? "暂停 空格" : "播放 空格"}
          disabled={!ready}
          onClick={onPlayPause}
        />
        <Button
          variant="icon"
          icon="next"
          aria-label="前进一秒"
          title="前进一秒"
          disabled={!ready}
          onClick={() => onNudge(1)}
        />
        {/* 播放器通道还没有变速命令(PlayerCommand 无 set_speed);入口先占位,接上即启用。 */}
        <Button
          variant="ghost"
          size="sm"
          className="monitor-speed"
          aria-label="播放速度"
          title="变速待播放器接入"
          disabled
        >
          ×1
        </Button>
        <Button
          variant="icon"
          icon={muted ? "volume-off" : "volume"}
          aria-label={muted ? "取消静音" : "静音"}
          aria-pressed={muted}
          title={muted ? "取消静音" : "静音"}
          disabled={!ready}
          onClick={onToggleMute}
        />

        <Toolbar.Divider />

        <span className="monitor-timecode">
          <span aria-label="当前时间码">{formatTimecode(status?.pos ?? 0, fps)}</span>
          <span className="monitor-duration" aria-label="素材总时长">
            {` / ${formatTimecode(status?.duration ?? 0, fps)}`}
          </span>
        </span>

        <Toolbar.Divider />

        <Button
          variant="secondary"
          size="sm"
          icon="mark-in"
          className={`monitor-mark${inPoint !== null ? " marked" : ""}`}
          aria-label="入点"
          aria-pressed={inPoint !== null}
          title={inPoint === null ? "入点 I" : `入点 ${formatTimecode(inPoint, fps)}`}
          disabled={!ready}
          onClick={onMarkIn}
        >
          <Kbd>I</Kbd>
          {inPoint !== null ? <span className="monitor-mark-value">{formatTimecode(inPoint, fps)}</span> : null}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon="mark-out"
          className={`monitor-mark${outPoint !== null ? " marked" : ""}`}
          aria-label="出点"
          aria-pressed={outPoint !== null}
          title={outPoint === null ? "出点 O" : `出点 ${formatTimecode(outPoint, fps)}`}
          disabled={!ready}
          onClick={onMarkOut}
        >
          <Kbd>O</Kbd>
          {outPoint !== null ? <span className="monitor-mark-value">{formatTimecode(outPoint, fps)}</span> : null}
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon="save"
          aria-label="保存片段"
          title="保存片段 S"
          disabled={!ready || saving}
          busy={saving}
          onClick={onSaveSegment}
        >
          保存片段
        </Button>

        <span className="monitor-marked" aria-live="polite">
          {notice ?? (marked === null ? "待打点" : `片段 ${formatTimecode(marked, fps)}`)}
        </span>

        <Toolbar.Spacer />

        <Button
          variant="secondary"
          size="sm"
          icon="fullscreen"
          className="monitor-fullscreen"
          aria-label="全屏沉浸"
          title="全屏沉浸 ⌘⏎"
          onClick={onRequestImmersive}
        >
          全屏 <Kbd>⌘⏎</Kbd>
        </Button>
      </Toolbar>
    </div>
  );
}
