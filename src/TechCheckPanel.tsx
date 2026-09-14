import { useCallback, useEffect, useRef, useState } from "react";

import { pictureSummary } from "./workspace/copy";

import {
  clearDisplayLut,
  importLut,
  listAudioTracks,
  listDisplayLuts,
  pickLutFile,
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

/**
 * R10 U-13:方向读后端 `clip.orientation`(rotation + 像素宽高综合判定,竖拍手机片 rotation=0 也能判成竖屏);
 * 旧库 / 桩没带这个字段时才回落到只看 rotation。角度照旧显示。
 */
function orientationLabel(clip: Pick<ClipListItem, "rotation" | "orientation">): string {
  const angle = ((clip.rotation ?? 0) % 360 + 360) % 360;
  const fallback = angle === 90 || angle === 270 ? "portrait" : "landscape";
  const orientation = clip.orientation && clip.orientation !== "unknown" ? clip.orientation : fallback;
  const word = orientation === "portrait" ? "竖屏" : orientation === "square" ? "方屏" : "横屏";
  return `${word} · ${angle}°`;
}

function colorBadges(clip: ClipListItem): Array<"D-Log" | "HDR"> {
  const badges: Array<"D-Log" | "HDR"> = [];
  const transfer = (clip.color_transfer ?? "").toLowerCase();
  if (transfer.includes("log") || transfer.includes("dlog")) badges.push("D-Log");
  if (clip.hdr_flag) badges.push("HDR");
  return badges;
}

function actualFrameRateLabel(clip: ClipListItem): string {
  if (!clip.fps_num || !clip.fps_den) return "";
  const fps = clip.fps_num / clip.fps_den;
  const formatted = Number.isInteger(fps) ? fps.toFixed(0) : fps.toFixed(2);
  return `${formatted} 帧/秒${clip.is_vfr ? "(帧率不稳)" : ""}`;
}

/** 「添加 LUT…」下拉项的哨兵值(R10 U-28)。 */
export const ADD_LUT_OPTION = "__add_lut__";
/** LUT 放置目录说明:与后端 `list_display_luts` 读的目录一致(应用支持目录下的 luts/)。 */
export const LUT_DIRECTORY_HINT =
  "把 .cube 文件放进 ~/Library/Application Support/TripCutStudio/luts/（读取列表时会自动创建这个目录），放好后点「刷新列表」。";

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
  const [lutHelpOpen, setLutHelpOpen] = useState(false);
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
    // 换素材先回到「未载入」:否则上一条的 tracksLoaded=true + 同样的 tracks.length 让下面的
    // 上报 effect 不再触发,检查器那行状态字就永远停在「加载中」(09-13 走查 U-27:切到 Take 2)。
    setTracksLoaded(false);
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
        // 读失败也是一个终态:上报 0 让状态字落到「未探测」,不能一直「加载中」。
        setTracks([]);
        setTracksLoaded(true);
      });
  }, [clipId]);

  useEffect(() => refreshTracks(), [refreshTracks]);

  useEffect(() => {
    if (!tracksLoaded) return;
    onCountChange?.(tracks.length);
    // clipId 进依赖:同一份计数换一条素材也要重报一次(检查器换素材时把计数清回 null)。
  }, [tracksLoaded, tracks.length, onCountChange, clipId]);

  const refreshLuts = useCallback(() => {
    listDisplayLuts()
      .then((result) => {
        if (!mounted.current) return;
        setError(null);
        setLuts(result);
      })
      .catch((loadError) => {
        if (!mounted.current) return;
        setError(`调色文件列表没载入：${String(loadError)}`);
      });
  }, []);

  useEffect(() => refreshLuts(), [refreshLuts]);

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

  // 「添加 LUT…」(R10 U-28):系统面板选 .cube → 后端校验并复制进 luts/ → 列表按返回值刷新。
  // 取消选择或导入被拒时,把放置目录说明摆出来作为手动路线的兜底。
  const onAddLut = () => {
    setLutBusy(true);
    pickLutFile()
      .then(async (path) => {
        if (!path) {
          if (mounted.current) setLutHelpOpen(true);
          return;
        }
        const next = await importLut(path);
        if (!mounted.current) return;
        setError(null);
        setLuts(next);
        setLutHelpOpen(false);
      })
      .catch((lutError) => {
        if (!mounted.current) return;
        setError(`添加调色文件没成功：${String(lutError)}`);
        setLutHelpOpen(true);
      })
      .finally(() => {
        if (mounted.current) setLutBusy(false);
      });
  };

  const onLutChange = (path: string) => {
    if (readOnly || clipId === null) return;
    if (path === ADD_LUT_OPTION) {
      onAddLut();
      return;
    }
    setLutBusy(true);
    const action = path === "" ? clearDisplayLut("clip", clipId) : setDisplayLut("clip", clipId, path);
    action
      .catch((lutError) => {
        if (!mounted.current) return;
        setError(`切换预览调色没成功：${String(lutError)}`);
      })
      .finally(() => {
        if (mounted.current) setLutBusy(false);
      });
  };

  const badges = colorBadges(clip);

  return (
    <div className="inspector-section inspector-tech-check">
      {hideTitle ? null : <span>技术检查</span>}
      {readOnly ? <p className="read-only-notice">历史集为只读档案；回到当前集才能修改声音与调色</p> : null}
      {error ? <p className="inspector-error">{error}</p> : null}
      <dl className="tech-check-basics">
        <div>
          <dt>画面</dt>
          <dd>{pictureSummary({ size: clip.width && clip.height ? `${clip.width}×${clip.height}` : null, fps: actualFrameRateLabel(clip), orientation: orientationLabel(clip) }) || "—"}</dd>
        </div>
        <div>
          <dt>编码</dt>
          <dd>{clip.codec ?? "—"}</dd>
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
        {/* R12 术语 v2:相机参数(ISO / 快门 / 光圈)设备没写就整段不显示,不再排三行占位。 */}
        {clip.iso_value != null || clip.shutter_speed || clip.aperture ? (
          <>
            <div>
              <dt>ISO</dt>
              <dd>{clip.iso_value != null ? clip.iso_value : "—"}</dd>
            </div>
            <div>
              <dt>快门</dt>
              <dd>{clip.shutter_speed ?? "—"}</dd>
            </div>
            <div>
              <dt>光圈</dt>
              <dd>{clip.aperture ?? "—"}</dd>
            </div>
          </>
        ) : null}
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
        <span>预览调色</span>
        <select
          aria-label="选择预览调色"
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
          <option value={ADD_LUT_OPTION}>添加调色文件…</option>
        </select>
        <small>仅用于预览，不影响导出</small>
        {lutHelpOpen ? (
          <div className="tech-check-lut-help" role="status">
            <p>{LUT_DIRECTORY_HINT}</p>
            <button
              type="button"
              onClick={() => {
                refreshLuts();
                setLutHelpOpen(false);
              }}
            >
              已放好，刷新列表
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
