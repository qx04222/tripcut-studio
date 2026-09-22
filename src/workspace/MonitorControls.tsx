import { useRef, useState, type JSX } from "react";

import { formatTimecode } from "../PlayerOverlay";
import type { ClipListItem, PlayerStatus } from "../api";
import { MonitorHeatStrip } from "./MonitorHeatStrip";
import { EditableTimecode } from "./scrubber/EditableTimecode";
import { clipFps } from "./useMonitorTransport";
import { MonitorSeekBar } from "./MonitorSeekBar";
import { ActionKbd, useActionKey } from "./KeymapKbd";
import { Button, Menu, Toggle, Toolbar } from "./ui";
import { PLAYBACK_RATES, type PlaybackRate } from "./useMonitorTransport";
import type { ClipSuggestionsState } from "./useClipSuggestions";
import type { PlaythroughRange } from "./playthrough/model";

export interface MonitorControlsProps {
  clip: ClipListItem;
  status: PlayerStatus | null;
  inPoint: number | null;
  outPoint: number | null;
  notice: string | null;
  saving: boolean;
  muted: boolean;
  /** R11 §3 / R12 §5:速度标签(×1 / ×2 / ×4 / ×0.5 / 倒退)。 */
  speedLabel?: string;
  /** Y-10:J 倒退中(mpv 其实是暂停 + 逐帧后退):走带按钮要显示「暂停」,按它 = 停下倒退。 */
  rewinding?: boolean;
  looping?: boolean;
  /** R11 §1.2:时刻热力与建议段;不传 = 不画(旧调用点不变)。 */
  suggestions?: ClipSuggestionsState;
  onPlayPause(): void;
  onNudge(seconds: -5 | -1 | 1 | 5): void;
  onToggleMute(): void;
  /** 没传 `onSelectSpeed` 时点「×1」等于按 L(旧调用点);传了就弹速度菜单(R12 §5)。 */
  onCycleSpeed?(): void;
  onSelectSpeed?(rate: PlaybackRate): void;
  onMarkIn(): void;
  onMarkOut(): void;
  onSaveSegment(): void;
  onStepSuggestion?(direction: 1 | -1): void;
  onRequestImmersive(): void;
  onSeek(seconds: number): void | Promise<unknown>;
  /** R22-B 镜头带连播的当前段(原样透传给进度条);不传 = 不连播。 */
  playthrough?: PlaythroughRange;
  onPause?(): void | Promise<void>;
  onResume?(): void | Promise<void>;
  onTrim?(edge: "in" | "out", seconds: number): void;
  onShuttle?(key: "j" | "k" | "l"): void;
  /** R12 §5:「连播」(播完自动下一条)的显式开关;不传 = 不画(旧调用点不变)。 */
  autoAdvance?: boolean;
  onToggleAutoAdvance?(): void;
}

/**
 * 传输条用的短时码(U-10):`mm:ss.d`,满一小时才带小时位。840px 的条打上入出点就
 * 溢出,三处 `00:00:06.066` 是主因;精确到毫秒的 `formatTimecode` 值留在 title 里,
 * 沉浸态的控件条不变。
 */
export function formatShortTimecode(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const tenths = Math.floor(safe * 10 + 1e-6);
  const whole = Math.floor(tenths / 10);
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const secs = whole % 60;
  const tail = `${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${tenths % 10}`;
  return hours > 0 ? `${hours}:${tail}` : tail;
}

/**
 * 监视器的传输条(规格 §3.6,形态按 C 稿的单一分组条):一条 framed Toolbar 里依次是
 * 走带(后退一秒 / 播放 / 前进一秒 / 速度 / 音量)· 打点(入点 I / 出点 O / 保存片段)·
 * 状态字 · 全屏;R10(U-09/U-10)在它上面加了一行「短时码 + 可拖 seek bar」,时间码
 * 从工具条里搬上去,工具条在中栏 520px 最小宽度下才放得下「全屏 ⌘⏎」。它不自己开
 * 播放器 —— 所有命令都经由 `Monitor` 手上的嵌入通道发给同一个 mpv 实例(规格 §3.2)。
 * AX 名与 R8 一字不差,图标全是装饰;新控件只有 slider「播放位置」。
 */
export function MonitorControls({
  clip,
  status,
  inPoint,
  outPoint,
  notice,
  saving,
  muted,
  speedLabel = "×1",
  rewinding = false,
  looping = false,
  suggestions,
  onPlayPause,
  onNudge,
  onToggleMute,
  onCycleSpeed,
  onSelectSpeed,
  onMarkIn,
  onMarkOut,
  onSaveSegment,
  onStepSuggestion,
  onRequestImmersive,
  onSeek, onPause, onResume, onTrim, onShuttle, playthrough,
  autoAdvance,
  onToggleAutoAdvance,
}: MonitorControlsProps): JSX.Element {
  const fps = clipFps(clip);
  const inKey = useActionKey("mark-in");
  const outKey = useActionKey("mark-out");
  const fullscreenKey = useActionKey("fullscreen");
  const speedButton = useRef<HTMLButtonElement | null>(null);
  const [speedMenu, setSpeedMenu] = useState<{ x: number; y: number } | null>(null);
  const openSpeedMenu = () => {
    if (!onSelectSpeed) {
      onCycleSpeed?.();
      return;
    }
    const rect = speedButton.current?.getBoundingClientRect();
    setSpeedMenu({ x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
  };
  const ready = status?.phase === "ready";
  // 倒退也算「在走」:按钮翻成暂停,标题说明是倒退中(真机 Y-10:J 后按钮仍写「播放」看不出在倒放)。
  const playing = status?.paused === false || rewinding;
  const marked = inPoint !== null && outPoint !== null && outPoint > inPoint
    ? outPoint - inPoint
    : null;

  // R19 V-05:热力画进 seek 轨道下沿;建议行并进传输条右端「建议 1/3 ‹ ›」,描述与「按 Enter 采用」进 tooltip。
  const heat =
    suggestions && suggestions.points.length > 0 && ready ? (
      <MonitorHeatStrip
        points={suggestions.points}
        ranges={suggestions.ranges}
        activeIndex={suggestions.index}
        durationSeconds={status.duration}
        position={status.pos}
      />
    ) : null;
  const suggestionShort = suggestions?.statusLine ? suggestions.statusLine.split(" · ")[0] ?? suggestions.statusLine : null;

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
          title={rewinding ? "暂停 空格 · 倒退中" : playing ? "暂停 空格" : "播放 空格"}
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
        {/* R12 §5:真变速(mpv speed)。L ×1 → ×2 → ×4 循环、J 倒退、K 停;点标签弹速度菜单。 */}
        <Button
          ref={speedButton}
          variant="ghost"
          size="sm"
          className="monitor-speed"
          aria-label="播放速度"
          aria-haspopup={onSelectSpeed ? "menu" : undefined}
          aria-expanded={onSelectSpeed ? speedMenu !== null : undefined}
          title="播放速度 · 加快 L · 倒退 J · 停 K"
          disabled={!ready}
          onClick={openSpeedMenu}
        >
          {speedLabel}
        </Button>
        {speedMenu && onSelectSpeed ? (
          <Menu
            x={speedMenu.x}
            y={speedMenu.y}
            ariaLabel="播放速度"
            items={PLAYBACK_RATES.map((rate) => ({ id: String(rate), label: `×${rate}`, ariaLabel: `速度 ×${rate}` }))}
            onSelect={(id) => onSelectSpeed(Number(id) as PlaybackRate)}
            onClose={() => setSpeedMenu(null)}
          />
        ) : null}
        <Button
          variant="icon"
          icon={muted ? "volume-off" : "volume"}
          aria-label={muted ? "取消静音" : "静音"}
          aria-pressed={muted}
          title={muted ? "取消静音" : "静音"}
          disabled={!ready}
          onClick={onToggleMute}
        />

        <span className="monitor-seek">
          <span className="monitor-timecode">
            <EditableTimecode seconds={status?.pos ?? 0} fps={fps} duration={status?.duration ?? 0} disabled={!ready} onSeek={onSeek} />
          </span>
          <MonitorSeekBar key={clip.id} fps={fps} onPause={onPause} onResume={onResume} onTrim={onTrim} onShuttle={onShuttle}
            onMark={edge => edge === "in" ? onMarkIn() : onMarkOut()} status={status} inPoint={inPoint} outPoint={outPoint} onSeek={onSeek} heat={heat} playthrough={playthrough} />
          <span className="monitor-timecode">
            <span className="monitor-duration" aria-label="素材总时长" title={formatTimecode(status?.duration ?? 0, fps)}>
              {formatShortTimecode(status?.duration ?? 0)}
            </span>
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
          title={inPoint === null ? `入点 ${inKey}` : `入点 ${formatTimecode(inPoint, fps)}`}
          disabled={!ready}
          onClick={onMarkIn}
        >
          <ActionKbd action="mark-in" />
          {inPoint !== null ? <span className="monitor-mark-value">{formatShortTimecode(inPoint)}</span> : null}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon="mark-out"
          className={`monitor-mark${outPoint !== null ? " marked" : ""}`}
          aria-label="出点"
          aria-pressed={outPoint !== null}
          title={outPoint === null ? `出点 ${outKey}` : `出点 ${formatTimecode(outPoint, fps)}`}
          disabled={!ready}
          onClick={onMarkOut}
        >
          <ActionKbd action="mark-out" />
          {outPoint !== null ? <span className="monitor-mark-value">{formatShortTimecode(outPoint)}</span> : null}
        </Button>
        {/* R19 V-01:栏内不再有实心主按钮(唯一一颗是顶栏「下一步」);保存靠位置与键位 S。 */}
        <Button
          variant="secondary"
          size="sm"
          icon="save"
          aria-label="保存片段"
          title="保存片段 S"
          disabled={!ready || saving}
          busy={saving}
          onClick={onSaveSegment}
        >
          <span className="monitor-save-label">保存片段</span>
        </Button>

        <span className="monitor-marked" aria-live="polite">
          {`${notice ?? (marked === null ? "待打点" : `片段 ${formatShortTimecode(marked)}`)}${looping ? " · 循环中" : ""}${
            speedLabel !== "×1" ? ` · ${speedLabel}` : ""
          }`}
        </span>

        {suggestions && suggestions.statusLine ? (
          <span
            className="monitor-suggestion"
            data-testid="monitor-suggestion"
            title={`${suggestions.statusLine} · 按 Enter 采用这段 · N / ⇧N 切换`}
          >
            <span className="monitor-suggestion-text" aria-live="polite" aria-label={suggestions.statusLine}>{suggestionShort}</span>
            <Button variant="ghost" size="sm" aria-label="上一条建议" title="上一条建议 ⇧N" disabled={!ready} onClick={() => onStepSuggestion?.(-1)}>
              ‹
            </Button>
            <Button variant="ghost" size="sm" aria-label="下一条建议" title="下一条建议 N · 按 Enter 采用这段" disabled={!ready} onClick={() => onStepSuggestion?.(1)}>
              ›
            </Button>
          </span>
        ) : null}

        {/* R12 §5:点卡片只预览;「连播」开了才播完自动下一条(默认关,与设置页同一个键)。 */}
        {onToggleAutoAdvance ? (
          <span className="monitor-auto-advance" title="播完自动播下一条">
            <span className="monitor-auto-advance-text" aria-hidden="true">连播</span>
            <Toggle label="连播" checked={autoAdvance === true} onChange={onToggleAutoAdvance} />
          </span>
        ) : null}

        <Button
          variant="secondary"
          size="sm"
          icon="fullscreen"
          className="monitor-fullscreen"
          aria-label="全屏沉浸"
          title={`全屏沉浸 ${fullscreenKey}`}
          onClick={onRequestImmersive}
        >
          全屏 <ActionKbd action="fullscreen" />
        </Button>
      </Toolbar>
    </div>
  );
}
