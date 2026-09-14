import { useMemo, type CSSProperties, type JSX, type ReactNode } from "react";

import { BAND_TIME_RULER_HEIGHT, rulerTicks, timecode, type TimelineSpan } from "./bandTimeline";
import type { BandTimeline } from "./useBandTimeline";

/**
 * R13 §4:镜头带视口上方的时间刻度轨(故事模式常驻)。刻度落在**节距轴**上(见 bandTimeline),
 * 跟着视口的 scrollLeft 平移;总时长决定步长(秒 / 10 秒 / 分钟)。
 *
 * 刻度本身是 `img`「时间刻度」;定位点击落在盖在它上面的一颗透明按钮上(AX 名「在时间刻度上定位」),
 * 键盘 Enter 定位到带的起点。播放头(红线)由 stage 统一画,这里只画它在刻度上的小三角。
 */
export function BandTimeRuler({
  spans,
  totalMs,
  scrollLeft,
  playheadPx,
  onSeekPx,
}: {
  spans: readonly TimelineSpan[];
  totalMs: number;
  scrollLeft: number;
  playheadPx: number | null;
  /** 节距轴上的像素 → 定位(ShotBand 换算成素材与时刻)。 */
  onSeekPx(px: number): void;
}): JSX.Element {
  const ticks = useMemo(() => rulerTicks(spans, totalMs), [spans, totalMs]);
  const last = spans[spans.length - 1];
  const width = last ? last.left + last.width : 0;
  return (
    <div className="band-time-ruler" style={{ height: BAND_TIME_RULER_HEIGHT }}>
      <div className="band-time-ruler-track" style={{ width, transform: `translateX(${-scrollLeft}px)` }}>
        <div className="band-time-ruler-ticks" role="img" aria-label="时间刻度" title={`共 ${timecode(totalMs)}`}>
          {ticks.map((tick) => (
            <span key={tick.ms} className={tick.label === null ? "band-time-mark" : "band-time-mark band-time-mark--label"} style={{ left: tick.px }}>
              {tick.label === null ? null : <span className="band-time-mark-label">{tick.label}</span>}
            </span>
          ))}
          {playheadPx === null ? null : <span className="band-time-playhead" style={{ left: playheadPx }} aria-hidden="true" />}
        </div>
        <button
          type="button"
          className="band-time-ruler-hit"
          aria-label="在时间刻度上定位"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            // 键盘触发(Enter / 空格)没有坐标,clientX 为 0 → 定位到带的起点。
            onSeekPx(event.clientX === 0 && event.clientY === 0 ? 0 : Math.max(0, event.clientX - rect.left));
          }}
        />
      </div>
    </div>
  );
}

/**
 * 刻度 + 视口 + 播放头同在一个 stage 里:红线是 stage 的绝对定位子元素,按
 * `--band-playhead-px`(节距轴像素 − scrollLeft)横移,贯穿刻度与镜块。
 * `ruler`:`"time"` = 故事模式的时间刻度;音乐模式把自己的 MusicRuler 递进来;null = 空带不出刻度。
 * `actions` 常驻刻度行右端(R13 §4 的「导入剪映继续剪」)—— 栏标题条在 1440 宽下已经放不下第二颗主按钮。
 */
export function BandTimelineStage({
  timeline,
  scrollLeft,
  ruler,
  actions,
  children,
}: {
  timeline: BandTimeline;
  scrollLeft: number;
  ruler: "time" | ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const { playhead } = timeline;
  return (
    <div
      className={playhead.playing ? "band-timeline-stage is-playing" : "band-timeline-stage"}
      style={{ "--band-playhead-px": playhead.px === null ? 0 : playhead.px - scrollLeft } as CSSProperties}
    >
      <div className="band-stage-top">
        {ruler === "time" ? (
          <BandTimeRuler spans={timeline.spans} totalMs={timeline.totalMs} scrollLeft={scrollLeft} playheadPx={playhead.px} onSeekPx={timeline.seekAtPx} />
        ) : (
          ruler
        )}
        {actions ? <div className="band-stage-actions">{actions}</div> : null}
      </div>
      {children}
      {playhead.px === null ? null : <span className="band-playhead" data-px={Math.round(playhead.px)} aria-hidden="true" />}
    </div>
  );
}
