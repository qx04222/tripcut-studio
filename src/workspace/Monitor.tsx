import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";

import { PlayerOverlay, type EmbeddedPlayerControls } from "../PlayerOverlay";
import {
  createSelectSegment,
  listClips,
  listStoryGaps,
  type ClipListItem,
  type PlayerStatus,
  type StoryGap,
} from "../api";
import { MonitorControls } from "./MonitorControls";
import { PaneHead } from "./PaneHead";
import { Chip, CoverImage, EmptyState, Icon } from "./ui";
import { usePlayerOcclusion } from "./usePlayerOcclusion";
import { useStageFit } from "./useStageFit";
import { dispatchWorkspace, useWorkspace } from "./WorkspaceStore";

/**
 * 规格 §11 的退化开关。`true` = 中上区里嵌同一个 mpv 实例(区域矩形 viewport);
 * 真机核对若发现画面与区域矩形不对齐(mpv 的 set_viewport 在非全屏小矩形下的
 * 偏移是全轮最大未知数),把它翻成 `false`:监视器只显示封面 + 「点击进入全屏沉浸」,
 * 省下的高度按规格 §2 让给镜头带。核对办法见 .superpowers/sdd/task-3-report.md。
 */
export let MONITOR_EMBEDDED_PLAYBACK = true;

/** 仅供测试用:翻转退化开关,覆盖 `!MONITOR_EMBEDDED_PLAYBACK` 那条分支。 */
export function __setEmbeddedPlaybackForTests(value: boolean): void {
  MONITOR_EMBEDDED_PLAYBACK = value;
}

/** 空槽位时监视器显示什么:章节标题 + 缺口 reason。 */
export function slotPlaceholderCopy(gap: StoryGap): { title: string; reason: string } {
  return { title: `${gap.chapter_title} · ${gap.slot_label_zh}`, reason: gap.reason };
}

/** 井右上角的规格 chip(A 稿「4K · 25p · 12.5 MB」):分辨率档 · 帧率 · 文件大小。 */
export function monitorSpecLabel(clip: ClipListItem): string {
  const height = Math.min(clip.width ?? 0, clip.height ?? 0) || (clip.height ?? 0);
  const long = Math.max(clip.width ?? 0, clip.height ?? 0);
  const resolution =
    long >= 3840 ? "4K" : long >= 2560 ? "2.7K" : height > 0 ? `${height}p` : "—";
  const fps =
    clip.fps_num !== null && clip.fps_den !== null && clip.fps_den > 0
      ? `${Math.round(clip.fps_num / clip.fps_den)}p`
      : "—";
  const bytes = clip.byte_size ?? 0;
  const size =
    bytes >= 1024 ** 3
      ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
      : bytes >= 1024 ** 2
        ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
        : `${(bytes / 1024).toFixed(1)} KB`;
  return `${resolution} · ${fps} · ${size}`;
}

/** 井底的 I/O 轨:入出点区间用强调色、播放头一根白线;纯装饰,数据都在控件条里。 */
function IoRail({
  status,
  inPoint,
  outPoint,
}: {
  status: PlayerStatus | null;
  inPoint: number | null;
  outPoint: number | null;
}): JSX.Element | null {
  if (!status || status.phase !== "ready" || status.duration <= 0) return null;
  const pct = (seconds: number) => `${Math.min(100, Math.max(0, (seconds / status.duration) * 100))}%`;
  return (
    <div className="monitor-io" aria-hidden="true">
      <div className="monitor-io-rail">
        {inPoint !== null ? (
          <span
            className="monitor-io-range"
            style={{ left: pct(inPoint), right: outPoint === null ? "auto" : `calc(100% - ${pct(outPoint)})`, width: outPoint === null ? "2px" : undefined }}
          />
        ) : null}
        {inPoint !== null ? <span className="monitor-io-mark monitor-io-mark--in" style={{ left: pct(inPoint) }} /> : null}
        {outPoint !== null ? <span className="monitor-io-mark monitor-io-mark--out" style={{ left: pct(outPoint) }} /> : null}
        <span className="monitor-io-head" style={{ left: pct(status.pos) }} />
      </div>
    </div>
  );
}

function Placeholder({ title, reason }: { title: string; reason?: string }): JSX.Element {
  return (
    <div className="monitor-stage">
      <div className="monitor-well monitor-well--empty">
        <EmptyState icon="play" size="inline" tone="dark" title={title} body={reason} />
      </div>
    </div>
  );
}

/** 栏标题条 + 画面区的公共外壳:标题右侧的状态字说的是「现在看的是哪一条」。 */
function MonitorFrame({ meta, children }: { meta: string; children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <div className="monitor">
      <PaneHead title="预览监视器" meta={meta} />
      {children}
    </div>
  );
}

export function Monitor(): JSX.Element {
  const selection = useWorkspace((state) => state.selection);
  const immersive = useWorkspace((state) => state.immersive);

  const [clips, setClips] = useState<readonly ClipListItem[]>([]);
  const [gaps, setGaps] = useState<readonly StoryGap[]>([]);
  const [status, setStatus] = useState<PlayerStatus | null>(null);
  const [inPoint, setInPoint] = useState<number | null>(null);
  const [outPoint, setOutPoint] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [muted, setMuted] = useState(false);
  const controlsRef = useRef<EmbeddedPlayerControls | null>(null);

  // 覆盖层打开时藏起原生视频视图(R9 D1);挂在这里是因为监视器在壳里常驻。
  usePlayerOcclusion();

  const selectedClipId = selection?.kind === "clip" ? selection.clipId : null;
  const selectedSlot = selection?.kind === "slot" ? selection : null;

  useEffect(() => {
    if (selectedClipId === null) return;
    let active = true;
    void listClips()
      .then((items) => {
        if (active) setClips(items);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [selectedClipId]);

  useEffect(() => {
    if (!selectedSlot) return;
    let active = true;
    void listStoryGaps()
      .then((items) => {
        if (active) setGaps(items);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [selectedSlot]);

  const clip = useMemo(
    () => (selectedClipId === null ? null : clips.find((item) => item.id === selectedClipId) ?? null),
    [clips, selectedClipId],
  );

  // 井同时装进舞台的宽和高,舞台一变就重提交区域矩形(R9 D5)。舞台只在嵌入
  // 播放分支里存在,所以 effect 只跟着「这条分支是否在渲染」重跑。
  const stageRef = useStageFit(MONITOR_EMBEDDED_PLAYBACK && !immersive && clip !== null && selectedSlot === null);

  // 换素材就把上一条的打点丢掉 —— 让 I/O 跨素材存活会把 A 的入点配上 B 的出点。
  useEffect(() => {
    setInPoint(null);
    setOutPoint(null);
    setNotice(null);
    setStatus(null);
  }, [selectedClipId]);

  const onStatusChange = useCallback((next: PlayerStatus | null) => setStatus(next), []);
  const enterImmersive = useCallback(
    () => dispatchWorkspace({ type: "set-immersive", immersive: true }),
    [],
  );
  const leaveImmersive = useCallback(
    () => dispatchWorkspace({ type: "set-immersive", immersive: false }),
    [],
  );

  const send = useCallback(async (commands: Parameters<EmbeddedPlayerControls["send"]>[0]) => {
    await controlsRef.current?.send(commands);
  }, []);

  const onPlayPause = useCallback(() => {
    void send([{ type: status?.paused === false ? "pause" : "play" }]);
  }, [send, status?.paused]);

  const onToggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    void send([{ type: "set_mute", muted: next }]);
  }, [send, muted]);

  const onNudge = useCallback(
    (seconds: -1 | 1) => {
      if (!status || status.phase !== "ready") return;
      const target = Math.min(status.duration, Math.max(0, status.pos + seconds));
      void send([{ type: "seek_abs", seconds: target }]);
    },
    [send, status],
  );

  const markAt = useCallback(
    (edge: "in" | "out") => {
      if (!status || status.phase !== "ready") return;
      const at = Math.min(status.duration, Math.max(0, status.pos));
      if (edge === "in") {
        setInPoint(at);
        // 入点越过旧出点后那段就没意义了,别留一个反向区间等着保存时才报错。
        setOutPoint((existing) => (existing !== null && existing <= at ? null : existing));
        setNotice("已设置入点");
        return;
      }
      setOutPoint(at);
      setNotice("已设置出点");
    },
    [status],
  );

  const onSaveSegment = useCallback(async () => {
    if (clip === null) return;
    if (inPoint === null || outPoint === null) {
      setNotice("请先用 I / O 设置完整入出点");
      return;
    }
    if (outPoint <= inPoint) {
      setNotice("出点必须晚于入点");
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      await createSelectSegment(clip.id as number, inPoint, outPoint);
      setNotice("精选段已保存");
      setInPoint(null);
      setOutPoint(null);
    } catch (reason) {
      setNotice(`精选段未保存：${String(reason).replace(/^Error:\s*/, "")}`);
    } finally {
      setSaving(false);
    }
  }, [clip, inPoint, outPoint]);

  if (immersive && clip) {
    // 沉浸态是同一条素材的另一种呈现;退出后 selection 不变,嵌入态接着播它。
    return <PlayerOverlay clip={clip} onExit={leaveImmersive} />;
  }

  if (selectedSlot) {
    const gap = gaps.find(
      (item) => item.chapter_id === selectedSlot.chapterId && item.slot === selectedSlot.slot,
    );
    const copy = gap
      ? slotPlaceholderCopy(gap)
      : { title: "这个槽位还没有素材", reason: "缺口详情载入中" };
    return (
      <MonitorFrame meta="空槽位">
        <Placeholder title={copy.title} reason={copy.reason} />
      </MonitorFrame>
    );
  }

  if (selectedClipId === null) {
    return (
      <MonitorFrame meta="未选择">
        <Placeholder title="从左侧媒体池选一条素材" reason="选中后在这里预览,I / O 打点。" />
      </MonitorFrame>
    );
  }

  if (clip === null) {
    return (
      <MonitorFrame meta="载入中">
        <Placeholder title="素材载入中" />
      </MonitorFrame>
    );
  }

  if (!MONITOR_EMBEDDED_PLAYBACK) {
    // 规格 §11 的退化路径:mpv 在小矩形下对不齐时走这条,画面只在沉浸态出现。
    return (
      <MonitorFrame meta={clip.file_name}>
        <div className="monitor-stage">
          <button type="button" className="monitor-well monitor-well--cover" onClick={enterImmersive}>
            <CoverImage src={clip.cover_url} />
            <span className="monitor-cover-hint">
              <Icon name="fullscreen" size={12} />
              点击进入全屏沉浸 ⌘⏎
            </span>
          </button>
        </div>
      </MonitorFrame>
    );
  }

  return (
    <MonitorFrame meta={clip.file_name}>
      <div className="monitor-stage" ref={stageRef}>
        <div className="monitor-well monitor-well--video">
          <PlayerOverlay
            clip={clip}
            variant="embedded"
            onExit={leaveImmersive}
            onRequestImmersive={enterImmersive}
            onStatusChange={onStatusChange}
            controlsRef={controlsRef}
          />
          {/* 两枚 chip 都是装饰:文件名在栏标题条里已经读过一遍,规格在检查器里。 */}
          <span className="monitor-well-chips" aria-hidden="true">
            <Chip className="monitor-well-name">{clip.file_name}</Chip>
            <Chip className="monitor-well-spec">{monitorSpecLabel(clip)}</Chip>
          </span>
          <IoRail status={status} inPoint={inPoint} outPoint={outPoint} />
        </div>
      </div>
      <MonitorControls
        clip={clip}
        status={status}
        inPoint={inPoint}
        outPoint={outPoint}
        notice={notice}
        saving={saving}
        muted={muted}
        onPlayPause={onPlayPause}
        onNudge={onNudge}
        onToggleMute={onToggleMute}
        onMarkIn={() => markAt("in")}
        onMarkOut={() => markAt("out")}
        onSaveSegment={() => void onSaveSegment()}
        onRequestImmersive={enterImmersive}
      />
    </MonitorFrame>
  );
}
