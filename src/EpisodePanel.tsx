import { useCallback, useEffect, useState } from "react";

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

const PLATFORM_LABELS: Record<TargetPlatform, string> = {
  douyin: "抖音",
  xiaohongshu: "小红书",
  bilibili: "B站",
  moments: "朋友圈",
  family: "家庭纪录",
  general: "通用",
};

const ORIENTATION_LABELS: Record<CanvasOrientation, string> = {
  landscape: "横屏",
  portrait: "竖屏",
  both: "同时",
};

function formatDate(value: string): string {
  return value.slice(0, 10);
}

function episodeErrorMessage(error: unknown): string {
  const message = String(error).replace(/^Error:\s*/i, "");
  if (message.includes("当前集还没有任何素材") || message.includes("空集不允许封存")) {
    return "当前集还没有素材，无需封存；可以继续使用本集并先导入素材。";
  }
  return message
    .replace(/^storyboard failed:\s*/i, "")
    .replaceAll(";", "；");
}

/** 侧栏「当前集」区块:集指示 + 集列表抽屉 + 封存滚动(P6-G1 最小 UI)。 */
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
            <div className="episode-edit">
              <input
                aria-label="集标题"
                value={draftTitle}
                maxLength={120}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraftTitle(value);
                }}
              />
              <input
                aria-label="集主题"
                value={draftTheme}
                maxLength={240}
                placeholder="主题(可留空)"
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraftTheme(value);
                }}
              />
              <label className="episode-platform-field">
                目标平台
                <select
                  aria-label="目标平台"
                  value={draftPlatform}
                  onChange={(event) => {
                    setDraftPlatform(event.currentTarget.value as TargetPlatform);
                  }}
                >
                  {(Object.keys(PLATFORM_LABELS) as TargetPlatform[]).map((platform) => (
                    <option key={platform} value={platform}>
                      {PLATFORM_LABELS[platform]}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="episode-orientation-field">
                <legend>画布方向</legend>
                {(Object.keys(ORIENTATION_LABELS) as CanvasOrientation[]).map((orientation) => (
                  <label key={orientation}>
                    <input
                      type="radio"
                      name="episode-orientation"
                      value={orientation}
                      checked={draftOrientation === orientation}
                      onChange={() => setDraftOrientation(orientation)}
                    />
                    {ORIENTATION_LABELS[orientation]}
                  </label>
                ))}
              </fieldset>
              <div className="episode-edit-actions">
                <button type="button" disabled={busy} onClick={() => void saveRename()}>保存</button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    setNotice(null);
                  }}
                >
                  取消
                </button>
              </div>
            </div>
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
              {archiveArmed ? (
                <div className="episode-archive-dialog" aria-label="封存并开启下一集">
                  <label className="episode-platform-field">
                    下一集目标平台
                    <select
                      aria-label="下一集目标平台"
                      value={archivePlatform}
                      disabled={busy}
                      onChange={(event) => {
                        setArchivePlatform(event.currentTarget.value as TargetPlatform);
                      }}
                    >
                      {(Object.keys(PLATFORM_LABELS) as TargetPlatform[]).map((platform) => (
                        <option key={platform} value={platform}>
                          {PLATFORM_LABELS[platform]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <fieldset className="episode-orientation-field">
                    <legend>下一集画布方向</legend>
                    {(Object.keys(ORIENTATION_LABELS) as CanvasOrientation[]).map((orientation) => (
                      <label key={orientation}>
                        <input
                          type="radio"
                          name="episode-archive-orientation"
                          value={orientation}
                          checked={archiveOrientation === orientation}
                          disabled={busy}
                          onChange={() => setArchiveOrientation(orientation)}
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
                title={archiveUnavailable ? "当前集没有素材，无需封存" : undefined}
                onClick={() => void archive()}
              >
                {archiveUnavailable
                  ? "空集无需封存"
                  : archiveArmed
                    ? "确认封存并开启下一集"
                    : "封存本集"}
              </button>
              {archiveArmed ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setArchiveArmed(false);
                    setNotice(null);
                  }}
                >
                  取消封存
                </button>
              ) : null}
            </div>
          )}

          {archiveUnavailable && !editing ? (
            <p className="episode-notice">请先导入素材；如需调整内容，可直接重命名本集。</p>
          ) : null}

          <ul className="episode-list" aria-label="集列表">
            {episodes.map((episode) => (
              <li key={episode.id} data-status={episode.status}>
                <button
                  type="button"
                  className="episode-view-link"
                  title={episode.status === "active" ? "回到当前集" : "只读查看该集素材"}
                  onClick={() => {
                    window.location.hash = "/review";
                    window.setTimeout(() => {
                      window.dispatchEvent(new CustomEvent("tripcut:view-episode", {
                        detail: episode.status === "active" ? null : { id: episode.id, title: episode.title },
                      }));
                    }, 120);
                    setOpen(false);
                  }}
                >
                <strong>{episode.title}</strong>
                <small>
                  {episode.status === "active"
                    ? "进行中"
                    : `已封存 ${episode.archived_at ? formatDate(episode.archived_at) : ""}`}
                  {" · "}
                  {episode.clip_count} 素材 · 交付 {episode.export_count}
                </small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {notice ? <p className="episode-notice" role="status">{notice}</p> : null}
    </div>
  );
}
