import { useCallback, useEffect, useRef, useState } from "react";

import {
  clearDisplayLut,
  listAudioTracks,
  listDisplayLuts,
  probeAudioTracks,
  setDisplayLut,
  setPlaybackTrack,
  setTranscribeTrack,
  type ClipAudioTrack,
  type ClipListItem,
} from "./api";

const ROLE_LABELS: Record<string, string> = {
  onboard_mic: "机头麦克风",
  wireless_mic: "无线麦克风",
  backup: "备份轨",
  unknown: "未知",
};

function channelLayoutLabel(track: ClipAudioTrack): string {
  if (track.channel_layout) return track.channel_layout;
  if (track.channels) return `${track.channels} 声道`;
  return "—";
}

function sampleRateLabel(track: ClipAudioTrack): string {
  return track.sample_rate ? `${track.sample_rate} Hz` : "—";
}

function orientationLabel(rotation: number | null | undefined): string {
  const angle = ((rotation ?? 0) % 360 + 360) % 360;
  const isPortrait = angle === 90 || angle === 270;
  return `${isPortrait ? "竖屏" : "横屏"} · ${angle}°`;
}

function colorBadges(clip: ClipListItem): Array<"D-Log" | "HDR"> {
  const badges: Array<"D-Log" | "HDR"> = [];
  const transfer = (clip.color_transfer ?? "").toLowerCase();
  if (transfer.includes("log") || transfer.includes("dlog")) badges.push("D-Log");
  if (clip.hdr_flag) badges.push("HDR");
  return badges;
}

function actualFrameRateLabel(clip: ClipListItem): string {
  if (!clip.fps_num || !clip.fps_den) return "—";
  const fps = clip.fps_num / clip.fps_den;
  const formatted = Number.isInteger(fps) ? fps.toFixed(0) : fps.toFixed(2);
  return `${formatted} fps${clip.is_vfr ? "（VFR）" : ""}`;
}

export function TechCheckPanel({
  clip,
  readOnly,
  onCountChange,
  hideTitle = false,
}: {
  clip: ClipListItem;
  readOnly: boolean;
  /** R9 检查器把它装进自己的折叠行(summary 已经叫「技术检查」),内部那行小标题不再画。 */
  hideTitle?: boolean;
  /** R8 Task 5 补丁:音轨数一旦从后端拿到就上报,供 Inspector 折叠段状态字用真实计数(加载完成前不上报)。 */
  onCountChange?: (count: number) => void;
}) {
  const clipId = clip.id;
  const [tracks, setTracks] = useState<ClipAudioTrack[]>([]);
  const [tracksLoaded, setTracksLoaded] = useState(false);
  const [luts, setLuts] = useState<string[]>([]);
  const [busyTrack, setBusyTrack] = useState<{ streamIndex: number; action: "monitor" | "transcribe" } | null>(null);
  const [probing, setProbing] = useState(false);
  const [lutBusy, setLutBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshTracks = useCallback(() => {
    if (clipId === null) return;
    const seq = ++latest.current;
    listAudioTracks(clipId)
      .then((result) => {
        if (seq !== latest.current || !mounted.current) return;
        setError(null);
        setTracks(result);
        setTracksLoaded(true);
      })
      .catch((loadError) => {
        if (seq !== latest.current || !mounted.current) return;
        setError(`音轨未载入：${String(loadError)}`);
      });
  }, [clipId]);

  useEffect(() => refreshTracks(), [refreshTracks]);

  useEffect(() => {
    if (!tracksLoaded) return;
    onCountChange?.(tracks.length);
  }, [tracksLoaded, tracks.length, onCountChange]);

  useEffect(() => {
    listDisplayLuts()
      .then((result) => {
        if (!mounted.current) return;
        setError(null);
        setLuts(result);
      })
      .catch((loadError) => {
        if (!mounted.current) return;
        setError(`LUT 列表未载入：${String(loadError)}`);
      });
  }, []);

  const onProbe = () => {
    if (readOnly || clipId === null) return;
    setProbing(true);
    probeAudioTracks(clipId)
      .then((result) => {
        if (!mounted.current) return;
        setTracks(result);
        setTracksLoaded(true);
      })
      .catch((probeError) => {
        if (!mounted.current) return;
        setError(`探测音轨失败：${String(probeError)}`);
      })
      .finally(() => {
        if (mounted.current) setProbing(false);
      });
  };

  const onSetMonitor = (streamIndex: number) => {
    if (readOnly || clipId === null) return;
    setBusyTrack({ streamIndex, action: "monitor" });
    setPlaybackTrack(clipId, streamIndex)
      .catch((setError_) => {
        if (!mounted.current) return;
        setError(`设置监听轨失败：${String(setError_)}`);
      })
      .finally(() => {
        if (mounted.current) setBusyTrack(null);
      });
  };

  const onSetTranscribe = (streamIndex: number) => {
    if (readOnly || clipId === null) return;
    setBusyTrack({ streamIndex, action: "transcribe" });
    setTranscribeTrack(clipId, streamIndex)
      .catch((setError_) => {
        if (!mounted.current) return;
        setError(`设置转录轨失败：${String(setError_)}`);
      })
      .finally(() => {
        if (mounted.current) setBusyTrack(null);
      });
  };

  const onLutChange = (path: string) => {
    if (readOnly || clipId === null) return;
    setLutBusy(true);
    const action = path === "" ? clearDisplayLut("clip", clipId) : setDisplayLut("clip", clipId, path);
    action
      .catch((lutError) => {
        if (!mounted.current) return;
        setError(`设置显示 LUT 失败：${String(lutError)}`);
      })
      .finally(() => {
        if (mounted.current) setLutBusy(false);
      });
  };

  const badges = colorBadges(clip);

  return (
    <div className="inspector-section inspector-tech-check">
      {hideTitle ? null : <span>技术检查</span>}
      {readOnly ? <p className="read-only-notice">历史集为只读档案；回到当前集才能修改音轨与 LUT</p> : null}
      {error ? <p className="inspector-error">{error}</p> : null}
      <dl className="tech-check-basics">
        <div>
          <dt>分辨率</dt>
          <dd>{clip.width && clip.height ? `${clip.width} × ${clip.height}` : "—"}</dd>
        </div>
        <div>
          <dt>实际帧率</dt>
          <dd>{actualFrameRateLabel(clip)}</dd>
        </div>
        <div>
          <dt>编码·位深</dt>
          <dd>{clip.codec ?? "—"}</dd>
        </div>
        <div>
          <dt>方向</dt>
          <dd>{orientationLabel(clip.rotation)}</dd>
        </div>
        <div>
          <dt>色彩</dt>
          <dd>
            {clip.color_transfer ?? "—"}
            {badges.map((badge) => (
              <span className={`tech-check-badge ${badge === "HDR" ? "hdr" : "dlog"}`} key={badge}>
                {badge}
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt>ISO</dt>
          <dd>{clip.iso_value != null ? clip.iso_value : "设备未提供"}</dd>
        </div>
        <div>
          <dt>快门</dt>
          <dd>{clip.shutter_speed ?? "设备未提供"}</dd>
        </div>
        <div>
          <dt>光圈</dt>
          <dd>{clip.aperture ?? "设备未提供"}</dd>
        </div>
      </dl>
      <div className="tech-check-audio">
        <div className="tech-check-audio-header">
          <span>音轨</span>
        </div>
        {tracks.length === 0 ? (
          <>
            <p>尚无音轨信息；点击「探测音轨」重新解析。</p>
            <button type="button" disabled={readOnly || probing || clipId === null} onClick={onProbe}>
              {probing ? "探测中…" : "探测音轨"}
            </button>
          </>
        ) : (
          <ul>
            {tracks.map((track) => {
              const isMonitor = clip.selected_monitor_track === track.stream_index;
              const isTranscribe = clip.selected_transcribe_track === track.stream_index;
              const monitorBusy = busyTrack?.streamIndex === track.stream_index && busyTrack.action === "monitor";
              const transcribeBusy = busyTrack?.streamIndex === track.stream_index && busyTrack.action === "transcribe";
              return (
                <li
                  key={track.stream_index}
                  className={`tech-check-track${isMonitor || isTranscribe ? " selected" : ""}`}
                >
                  <strong>#{track.stream_index}</strong>
                  <span>{channelLayoutLabel(track)}</span>
                  <span>{sampleRateLabel(track)}</span>
                  <small>{ROLE_LABELS[track.role_guess ?? "unknown"] ?? "未知"}</small>
                  {isMonitor ? <small className="primary-badge">监听中</small> : null}
                  {isTranscribe ? <small className="primary-badge">转录轨</small> : null}
                  <button
                    type="button"
                    disabled={readOnly || clipId === null || monitorBusy}
                    onClick={() => onSetMonitor(track.stream_index)}
                  >
                    {monitorBusy ? "设置中…" : "监听"}
                  </button>
                  <button
                    type="button"
                    disabled={readOnly || clipId === null || transcribeBusy}
                    onClick={() => onSetTranscribe(track.stream_index)}
                  >
                    {transcribeBusy ? "设置中…" : "设为转录轨"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="tech-check-lut">
        <span>显示 LUT</span>
        <select
          aria-label="选择显示 LUT"
          value={clip.display_lut_path ?? ""}
          disabled={readOnly || clipId === null || lutBusy}
          onChange={(event) => onLutChange(event.currentTarget.value)}
        >
          <option value="">无</option>
          {luts.map((path) => (
            <option value={path} key={path}>
              {path.split("/").pop()}
            </option>
          ))}
        </select>
        <small>仅用于预览，不影响导出</small>
      </div>
    </div>
  );
}
