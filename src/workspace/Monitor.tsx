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

export { monitorSpecLabel, slotPlaceholderCopy } from "./MonitorParts";
import { notePlayerStatus } from "./guides";
import { MonitorControls } from "./MonitorControls";
import { MonitorIdle } from "./OnboardingCard";
import { IoRail, MonitorFrame, Placeholder, slotPlaceholderCopy } from "./MonitorParts";
import { isAtEnd } from "./MonitorSeekBar";
import { loadPlayerPrefs } from "./playerPrefs";
import { CoverImage, Icon } from "./ui";
import { useClipsFeed } from "./useClipsFeed";
import { useClipSuggestions } from "./useClipSuggestions";
import { useMonitorHotkeys } from "./useMonitorHotkeys";
import { useMonitorTransport } from "./useMonitorTransport";
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

export function Monitor(): JSX.Element {
  const selection = useWorkspace((state) => state.selection);
  const immersive = useWorkspace((state) => state.immersive);
  const feed = useClipsFeed();

  const [clips, setClips] = useState<readonly ClipListItem[]>([]);
  const [gaps, setGaps] = useState<readonly StoryGap[]>([]);
  const [status, setStatus] = useState<PlayerStatus | null>(null);
  const [inPoint, setInPoint] = useState<number | null>(null);
  const [outPoint, setOutPoint] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const controlsRef = useRef<EmbeddedPlayerControls | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 覆盖层打开时藏起原生视频视图(R9 D1);挂在这里是因为监视器在壳里常驻。
  usePlayerOcclusion();
  // 播放器偏好(R11 §3)只在首次挂载读一次表。
  useEffect(() => void loadPlayerPrefs(), []);

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
  // R17 playfix:全屏来回 = 嵌入态的播放器卸了再挂(新实例)。沉浸态不往这里推状态,
  // 留着的旧状态会让走带以为「还是刚才那份就绪」—— 重开后就不再暂停、不再停到最精彩处。
  useEffect(() => {
    setStatus(null);
  }, [immersive]);

  const onStatusChange = useCallback((next: PlayerStatus | null) => {
    setStatus(next);
    notePlayerStatus(next); // R13 §3:「连播」气泡在第一次播完时出
  }, []);
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
    if (status?.paused === false) {
      void send([{ type: "pause" }]);
      return;
    }
    // U-09:mpv keep-open 停在尾帧时单发 play 什么都不会发生(图标翻成暂停、时间不动)。
    // 播完再按播放 = 从头放。
    void send(isAtEnd(status) ? [{ type: "seek_abs", seconds: 0 }, { type: "play" }] : [{ type: "play" }]);
  }, [send, status]);

  // R11 §1.2:时刻分 + 建议段;§3:变速 / 逐帧 / 循环 / 自动下一条 / 静音记忆 / 从最高分开播。
  const suggestions = useClipSuggestions(clip, status?.phase === "ready" ? status.duration : 0);
  // 所有 seek 走走带的 seekTo:它记着「最后要去的位置」,暂停态下 seek 未落地时打点 / 逐帧
  // 才不会拿旧读数算(V-04)。
  const transport = useMonitorTransport({
    clip,
    status,
    send,
    inPoint,
    outPoint,
    bestStart: suggestions.bestStart,
    momentsLoaded: suggestions.momentsLoaded,
  });
  const onNudge = transport.nudge;
  const onSeek = transport.seekTo;
  // Y-10:J 倒退中 mpv 是暂停的,单看 status 会把空格 / 走带按钮当成「播放」—— 倒退中一律等于 K(停下)。
  const { rewinding, shuttle } = transport;
  const togglePlayback = useCallback(() => {
    if (rewinding) {
      shuttle("k");
      return;
    }
    onPlayPause();
  }, [rewinding, shuttle, onPlayPause]);

  // 当前建议一变(载入 / N / ⇧N)就把入出点填成它 —— I / O 微调、S 或 Enter 保存,都是同一条路。
  const { current: currentSuggestion, index: suggestionIndex } = suggestions;
  useEffect(() => {
    if (!currentSuggestion) return;
    setInPoint(currentSuggestion.inSeconds);
    setOutPoint(currentSuggestion.outSeconds);
  }, [currentSuggestion]);
  const onStepSuggestion = useCallback(
    (direction: 1 | -1) => {
      const next = suggestions.step(direction);
      if (next) onSeek(next.inSeconds);
    },
    [suggestions, onSeek],
  );

  // 媒体池 / 镜头带的空格键与音乐刻度轨的「建议切点」都不认识播放器,只往 window 上
  // 广播:`tripcut:toggle-playback`(播放/暂停,播完则从头)与 `tripcut:seek-ratio`
  // ({ratio} 0..1)。监视器是唯一握着嵌入通道的人,在这里收。用 ref 拿最新的处理函数,
  // 监听器只挂一次,不跟着 80ms 的状态轮询反复拆装。
  const latest = useRef({ onPlayPause: togglePlayback, onSeek, status });
  useEffect(() => {
    latest.current = { onPlayPause: togglePlayback, onSeek, status };
  }, [togglePlayback, onSeek, status]);
  useEffect(() => {
    const toggle = () => latest.current.onPlayPause();
    const seekRatio = (event: Event) => {
      const ratio = (event as CustomEvent<{ ratio?: unknown }>).detail?.ratio;
      const current = latest.current.status;
      if (typeof ratio !== "number" || !Number.isFinite(ratio) || !current || current.phase !== "ready") return;
      latest.current.onSeek(Math.min(1, Math.max(0, ratio)) * current.duration);
    };
    window.addEventListener("tripcut:toggle-playback", toggle);
    window.addEventListener("tripcut:seek-ratio", seekRatio);
    return () => {
      window.removeEventListener("tripcut:toggle-playback", toggle);
      window.removeEventListener("tripcut:seek-ratio", seekRatio);
    };
  }, []);

  const markAt = useCallback(
    (edge: "in" | "out") => {
      // 位置取走带的 position():暂停态 seek 还没落地时,状态里的 pos 是旧的(V-04)。
      const at = transport.position();
      if (!status || status.phase !== "ready" || at === null) return;
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
    [status, transport],
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
      setNotice(suggestionIndex >= 0 ? `已采用建议 ${suggestionIndex + 1} · 精选段已保存` : "精选段已保存");
      setInPoint(null);
      setOutPoint(null);
      transport.stopLoop();
    } catch (reason) {
      setNotice(`精选段未保存：${String(reason).replace(/^Error:\s*/, "")}`);
    } finally {
      setSaving(false);
    }
  }, [clip, inPoint, outPoint, suggestionIndex, transport]);

  // 单键全走 useMonitorHotkeys(R10 建):J/K/L 变速在 transport 里,Enter 采纳 = 保存当前入出点。
  useMonitorHotkeys(rootRef, {
    onMark: markAt,
    onNudge,
    onShuttle: transport.shuttle,
    onTogglePlayback: togglePlayback,
    onAdoptSuggestion: suggestionIndex >= 0 ? () => void onSaveSegment() : undefined,
    onStepSuggestion,
    onFrame: transport.frame,
    onToggleLoop: transport.toggleLoop,
    onSave: () => void onSaveSegment(),
  });

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
    // R11 简化专项 #1:整个素材库(不按集裁)为空且没看过引导时,这里是三步上手卡;否则是原来的占位句。
    return (
      <MonitorFrame meta="未选择">
        <MonitorIdle clipCount={feed.allClips.length} loading={feed.loading} />
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
    <MonitorFrame meta={clip.file_name} rootRef={rootRef}>
      <div className="monitor-stage" ref={stageRef}>
        <div className="monitor-well monitor-well--video">
          {/* 井底铺封面(U-09):原生 mpv 视图压在 WKWebView 之上,画面在时它盖住这层;
              被覆盖层遮挡(player_set_occluded)或链路还没建好时,露出来的是封面而不是整块黑。 */}
          <CoverImage src={clip.cover_url} className="monitor-well-backdrop" />
          <PlayerOverlay
            clip={clip}
            variant="embedded"
            onExit={leaveImmersive}
            onRequestImmersive={enterImmersive}
            onStatusChange={onStatusChange}
            controlsRef={controlsRef}
          />
          {/* R19 V-05:井内不再挂文件名 / 规格 chip —— 文件名在栏标题条里,规格在检查器里,一件事只说一遍。 */}
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
        muted={transport.muted}
        speedLabel={transport.speedLabel}
        rewinding={transport.rewinding}
        looping={transport.looping}
        suggestions={suggestions}
        onPlayPause={togglePlayback}
        onNudge={onNudge}
        onToggleMute={transport.toggleMute}
        onCycleSpeed={() => transport.shuttle("l")}
        onSelectSpeed={transport.setRate}
        onMarkIn={() => markAt("in")}
        onMarkOut={() => markAt("out")}
        onSaveSegment={() => void onSaveSegment()}
        onStepSuggestion={onStepSuggestion}
        onRequestImmersive={enterImmersive}
        onSeek={onSeek}
        autoAdvance={transport.autoAdvance}
        onToggleAutoAdvance={transport.toggleAutoAdvance}
      />
    </MonitorFrame>
  );
}
