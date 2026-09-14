import { useCallback, useEffect, useState, type JSX } from "react";

import {
  archiveCurrentEpisode,
  getCurrentEpisode,
  listEpisodes,
  renameCurrentEpisode,
  setEpisodePlatform,
  type CanvasOrientation,
  type EpisodeSummary,
  type TargetPlatform,
} from "./api";

export const PLATFORM_LABELS: Record<TargetPlatform, string> = {
  douyin: "抖音",
  xiaohongshu: "小红书",
  bilibili: "B站",
  moments: "朋友圈",
  family: "家庭纪录",
  general: "通用",
};

export const ORIENTATION_LABELS: Record<CanvasOrientation, string> = {
  landscape: "横屏",
  portrait: "竖屏",
  both: "同时",
};

function formatDate(value: string): string {
  return value.slice(0, 10);
}

export function episodeErrorMessage(error: unknown): string {
  const message = String(error).replace(/^Error:\s*/i, "");
  if (message.includes("当前集还没有任何素材") || message.includes("空集不允许封存")) {
    return "这一集还没有素材，不用结束；继续用这一集，先导入素材。";
  }
  return message
    .replace(/^storyboard failed:\s*/i, "")
    .replaceAll(";", "；");
}

/**
 * 集列表(规格 Task 6c):点进行中集回到当前集,点已封存集只读查看。EpisodePanel
 * (旗关路径)与 EpisodeSwitcher(旗开路径)共用同一份列表渲染与点击语义,行为
 * 不因挂载位置而漂移。
 */
export function EpisodeList({
  episodes,
  onSelectEpisode,
}: {
  episodes: EpisodeSummary[];
  onSelectEpisode: (episode: EpisodeSummary) => void;
}): JSX.Element {
  return (
    <ul className="episode-list" aria-label="集列表">
      {episodes.map((episode) => (
        <li key={episode.id} data-status={episode.status}>
          <button
            type="button"
            className="episode-view-link"
            title={episode.status === "active" ? "回到当前集" : "只读查看该集素材"}
            onClick={() => onSelectEpisode(episode)}
          >
            <strong>{episode.title}</strong>
            <small>
              {episode.status === "active"
                ? "进行中"
                : `已结束 ${episode.archived_at ? formatDate(episode.archived_at) : ""}`}
              {" · "}
              {episode.clip_count} 条素材 · 已导出 {episode.export_count} 次
            </small>
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface EpisodeRenameFormProps {
  busy: boolean;
  draftTitle: string;
  draftTheme: string;
  draftPlatform: TargetPlatform;
  draftOrientation: CanvasOrientation;
  onTitleChange: (value: string) => void;
  onThemeChange: (value: string) => void;
  onPlatformChange: (value: TargetPlatform) => void;
  onOrientationChange: (value: CanvasOrientation) => void;
  onSave: () => void;
  onCancel: () => void;
}

/** 重命名表单(含「目标平台」字段)——EpisodePanel 与 EpisodeSwitcher 共用。 */
export function EpisodeRenameForm({
  busy,
  draftTitle,
  draftTheme,
  draftPlatform,
  draftOrientation,
  onTitleChange,
  onThemeChange,
  onPlatformChange,
  onOrientationChange,
  onSave,
  onCancel,
}: EpisodeRenameFormProps): JSX.Element {
  return (
    <div className="episode-edit">
      <input
        aria-label="集标题"
        value={draftTitle}
        maxLength={120}
        onChange={(event) => onTitleChange(event.currentTarget.value)}
      />
      <input
        aria-label="集主题"
        value={draftTheme}
        maxLength={240}
        placeholder="主题(可留空)"
        onChange={(event) => onThemeChange(event.currentTarget.value)}
      />
      <label className="episode-platform-field">
        目标平台
        <select
          aria-label="目标平台"
          value={draftPlatform}
          onChange={(event) => onPlatformChange(event.currentTarget.value as TargetPlatform)}
        >
          {(Object.keys(PLATFORM_LABELS) as TargetPlatform[]).map((platform) => (
            <option key={platform} value={platform}>
              {PLATFORM_LABELS[platform]}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="episode-orientation-field">
        <legend>画面方向</legend>
        {(Object.keys(ORIENTATION_LABELS) as CanvasOrientation[]).map((orientation) => (
          <label key={orientation}>
            <input
              type="radio"
              name="episode-orientation"
              value={orientation}
              checked={draftOrientation === orientation}
              onChange={() => onOrientationChange(orientation)}
            />
            {ORIENTATION_LABELS[orientation]}
          </label>
        ))}
      </fieldset>
      <div className="episode-edit-actions">
        <button type="button" disabled={busy} onClick={onSave}>保存</button>
        <button type="button" disabled={busy} onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

export interface EpisodeArchiveControlsProps {
  busy: boolean;
  archiveArmed: boolean;
  archiveUnavailable: boolean;
  archivePlatform: TargetPlatform;
  archiveOrientation: CanvasOrientation;
  onArchivePlatformChange: (value: TargetPlatform) => void;
  onArchiveOrientationChange: (value: CanvasOrientation) => void;
  onArchive: () => void;
  onCancelArchive: () => void;
}

/** 结束本集(封存)+ 下一集平台/方向选择——EpisodePanel 与 EpisodeSwitcher 共用。Y-11:用户面前叫「结束本集」,代码里仍是 archive。 */
export function EpisodeArchiveControls({
  busy,
  archiveArmed,
  archiveUnavailable,
  archivePlatform,
  archiveOrientation,
  onArchivePlatformChange,
  onArchiveOrientationChange,
  onArchive,
  onCancelArchive,
}: EpisodeArchiveControlsProps): JSX.Element {
  return (
    <>
      {archiveArmed ? (
        <div className="episode-archive-dialog" aria-label="结束本集并开始下一集">
          <label className="episode-platform-field">
            下一集目标平台
            <select
              aria-label="下一集目标平台"
              value={archivePlatform}
              disabled={busy}
              onChange={(event) => onArchivePlatformChange(event.currentTarget.value as TargetPlatform)}
            >
              {(Object.keys(PLATFORM_LABELS) as TargetPlatform[]).map((platform) => (
                <option key={platform} value={platform}>
                  {PLATFORM_LABELS[platform]}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="episode-orientation-field">
            <legend>下一集画面方向</legend>
            {(Object.keys(ORIENTATION_LABELS) as CanvasOrientation[]).map((orientation) => (
              <label key={orientation}>
                <input
                  type="radio"
                  name="episode-archive-orientation"
                  value={orientation}
                  checked={archiveOrientation === orientation}
                  disabled={busy}
                  onChange={() => onArchiveOrientationChange(orientation)}
                />
                {ORIENTATION_LABELS[orientation]}
              </label>
            ))}
          </fieldset>
        </div>
      ) : null}
      <button
        type="button"
        className={archiveArmed ? "danger armed" : "danger"}
        disabled={busy || archiveUnavailable}
        title={archiveUnavailable ? "这一集还没有素材，不用结束" : undefined}
        onClick={onArchive}
      >
        {archiveUnavailable ? "这一集还没有素材" : archiveArmed ? "确认结束，开始下一集" : "结束本集"}
      </button>
      {archiveArmed ? (
        <button type="button" disabled={busy} onClick={onCancelArchive}>
          先不结束
        </button>
      ) : null}
    </>
  );
}

/** 侧栏「当前集」区块:集指示 + 集列表抽屉 + 封存滚动(P6-G1 最小 UI)。旗关路径专用——
 * 旗开时顶栏 `EpisodeSwitcher` 接管同一套业务逻辑,两者共用上面三个导出的子组件。 */
export function EpisodePanel() {
  const [current, setCurrent] = useState<EpisodeSummary | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [archiveArmed, setArchiveArmed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftTheme, setDraftTheme] = useState("");
  const [draftPlatform, setDraftPlatform] = useState<TargetPlatform>("general");
  const [draftOrientation, setDraftOrientation] = useState<CanvasOrientation>("landscape");
  const [archivePlatform, setArchivePlatform] = useState<TargetPlatform>("general");
  const [archiveOrientation, setArchiveOrientation] = useState<CanvasOrientation>("landscape");

  const refresh = useCallback(async () => {
    const [nextCurrent, nextList] = await Promise.all([getCurrentEpisode(), listEpisodes()]);
    setCurrent(nextCurrent);
    setEpisodes(nextList);
  }, []);

  useEffect(() => {
    const update = () => {
      void refresh().catch((error) => setNotice(String(error)));
    };
    update();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") update();
    }, 5_000);
    window.addEventListener("tripcut:library-changed", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("tripcut:library-changed", update);
    };
  }, [refresh]);

  const archive = async () => {
    if (!archiveArmed) {
      if (current) {
        setArchivePlatform(current.target_platform);
        setArchiveOrientation(current.canvas_orientation);
      }
      setArchiveArmed(true);
      setNotice("再次点击确认:本集将封存为只读档案,并按下方选择开启下一集。");
      return;
    }
    setArchiveArmed(false);
    setBusy(true);
    try {
      const outcome = await archiveCurrentEpisode(null, archivePlatform, archiveOrientation);
      setNotice(`已封存「${outcome.archived.title}」,当前进入「${outcome.next.title}」`);
      // 封存在同一路由内完成时,SelectPage/Storyboard/DeliverPage 各自持有的
      // activeEpisodeId 不会自动感知——广播新 active 集,避免它们继续把刚
      // 封存的旧集当成当前集(回归说明：封存后筛片页不切换 active 集)。
      window.dispatchEvent(
        new CustomEvent("tripcut:episode-changed", { detail: { id: outcome.next.id, title: outcome.next.title } }),
      );
      try {
        await refresh();
      } catch (refreshError) {
        console.error("episode list refresh failed after archive", refreshError);
        setCurrent(outcome.next);
        setNotice(`已封存「${outcome.archived.title}」，但集列表刷新失败；当前已切换到「${outcome.next.title}」。`);
      }
    } catch (error) {
      setNotice(episodeErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const saveRename = async () => {
    if (!current) return;
    setBusy(true);
    try {
      await renameCurrentEpisode(draftTitle, draftTheme);
      await setEpisodePlatform(current.id, draftPlatform, draftOrientation);
      setEditing(false);
      setNotice("集信息已更新");
      await refresh();
    } catch (error) {
      setNotice(episodeErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  if (!current) {
    return (
      <div className="episode-panel" aria-label="当前集">
        <button type="button" className="episode-current" disabled>
          <strong>集信息读取中…</strong>
        </button>
        {notice ? <p className="episode-notice">{notice}</p> : null}
      </div>
    );
  }

  const archiveUnavailable = current.clip_count === 0;

  return (
    <div className="episode-panel" aria-label="当前集">
      <button
        type="button"
        className={`episode-current${open ? " open" : ""}`}
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          setArchiveArmed(false);
          setNotice(null);
        }}
      >
        <span className="episode-kicker">CURRENT EPISODE {open ? "▾" : "▸"}</span>
        <strong>
          {current.title}
          <span className="episode-platform-badge">
            {PLATFORM_LABELS[current.target_platform]} · {ORIENTATION_LABELS[current.canvas_orientation]}
          </span>
        </strong>
        <small>
          {current.clip_count} 素材 · {current.favorite_count} 收藏
        </small>
      </button>

      {open ? (
        <div className="episode-drawer">
          {editing ? (
            <EpisodeRenameForm
              busy={busy}
              draftTitle={draftTitle}
              draftTheme={draftTheme}
              draftPlatform={draftPlatform}
              draftOrientation={draftOrientation}
              onTitleChange={setDraftTitle}
              onThemeChange={setDraftTheme}
              onPlatformChange={setDraftPlatform}
              onOrientationChange={setDraftOrientation}
              onSave={() => void saveRename()}
              onCancel={() => {
                setEditing(false);
                setNotice(null);
              }}
            />
          ) : (
            <div className="episode-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraftTitle(current.title);
                  setDraftTheme(current.theme);
                  setDraftPlatform(current.target_platform);
                  setDraftOrientation(current.canvas_orientation);
                  setEditing(true);
                  setNotice(null);
                }}
              >
                重命名本集
              </button>
              <EpisodeArchiveControls
                busy={busy}
                archiveArmed={archiveArmed}
                archiveUnavailable={archiveUnavailable}
                archivePlatform={archivePlatform}
                archiveOrientation={archiveOrientation}
                onArchivePlatformChange={setArchivePlatform}
                onArchiveOrientationChange={setArchiveOrientation}
                onArchive={() => void archive()}
                onCancelArchive={() => {
                  setArchiveArmed(false);
                  setNotice(null);
                }}
              />
            </div>
          )}

          {archiveUnavailable && !editing ? (
            <p className="episode-notice">请先导入素材；如需调整内容，可直接重命名本集。</p>
          ) : null}

          <EpisodeList
            episodes={episodes}
            onSelectEpisode={(episode) => {
              window.location.hash = "/review";
              window.setTimeout(() => {
                window.dispatchEvent(new CustomEvent("tripcut:view-episode", {
                  detail: episode.status === "active" ? null : { id: episode.id, title: episode.title },
                }));
              }, 120);
              setOpen(false);
            }}
          />
        </div>
      ) : null}

      {notice ? <p className="episode-notice" role="status">{notice}</p> : null}
    </div>
  );
}
