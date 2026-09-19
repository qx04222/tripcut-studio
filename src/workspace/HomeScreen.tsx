import { useCallback, useEffect, useState, type JSX } from "react";

import { createEpisode, deleteEpisode, listEpisodes, type EpisodeSummary } from "../api";
import { episodeErrorMessage } from "../EpisodePanel";
import { EPISODES_UPDATED_EVENT } from "./copy";
import { EpisodeDeleteConfirm, episodeDeleteConsequence } from "./EpisodeDeleteConfirm";
import { EpisodeMenu, EpisodeRenameInline, type EpisodeMenuState } from "./EpisodeMenu";
import { EpisodeCard, PresetCards } from "./HomeCards";
import { episodeProgress, newEpisodeTitle, recentEpisodes } from "./homeModel";
import { pinHome } from "./homeStore";
import { ONBOARDING_STEPS } from "./onboarding";
import { SELECT_PROMPT_EVENT } from "./selectPrompt";
import { Button, Icon } from "./ui";
import { useClipsFeed } from "./useClipsFeed";
import { usePipeline } from "./usePipeline";
import { useOccludesPlayer } from "./usePlayerOcclusion";
import { dispatchWorkspace } from "./WorkspaceStore";

/**
 * R13 §3(车道 B)→ R19 U-03(flow 车道):零术语首页。空库时自动出现,或点顶栏 logo 进来(homeStore)。
 * 一屏三件事:一句话 + 「新建一集」(唯一 primary)/「继续上次」(当前集有素材才出)+ 「最近的集」卡片。
 * 模板区撤掉(Wave 2 P-09 做实三条预设句再回);四步条改成动作句,由 `ONBOARDING_STEPS` 承接
 * 导航条提示条的文案(shell 车道删 PipelineHint)。首页 DOM 不出现首轮词表(`FIRST_ROUND_VOCABULARY`)。
 * AX:region「首页」/ button「新建一集」「继续上次」(新名;旧名「开始一个新旅程」释放)/ list「最近的集」/ status「新建确认」。
 */
export function HomeScreen(): JSX.Element {
  const feed = useClipsFeed();
  const pipeline = usePipeline();
  // Y-01:首页盖住整个工作区,原生 mpv 视图却画在 WKWebView 之上 —— 在场期间让它让位。
  useOccludesPlayer();
  const [episodes, setEpisodes] = useState<EpisodeSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingNew, setConfirmingNew] = useState(false);
  // R15:集卡片「···」菜单与「删除这一集」确认。
  const [menu, setMenu] = useState<EpisodeMenuState | null>(null);
  const [deleting, setDeleting] = useState<EpisodeSummary | null>(null);
  // R16 P2-3:集卡「重命名」针对哪一集。
  const [renaming, setRenaming] = useState<EpisodeSummary | null>(null);

  const refresh = useCallback(() => {
    void listEpisodes()
      .then((list) => setEpisodes(list))
      .catch(() => setEpisodes([]));
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener("tripcut:episode-changed", refresh);
    // R17 epmove:素材移到其他集后集卡计数要跟着动(那条事件不重置导出表单,所以单独一条)。
    window.addEventListener(EPISODES_UPDATED_EVENT, refresh);
    return () => {
      window.removeEventListener("tripcut:episode-changed", refresh);
      window.removeEventListener(EPISODES_UPDATED_EVENT, refresh);
    };
  }, [refresh]);

  const openImport = () => {
    pinHome(false);
    dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "source" });
  };

  const openEpisode = (episode: EpisodeSummary) => {
    pinHome(false);
    if (episode.status === "active") return;
    window.dispatchEvent(new CustomEvent("tripcut:view-episode", { detail: { id: episode.id, title: episode.title } }));
  };

  const current = feed.episode.current;
  const currentHasClips = (current?.clip_count ?? 0) > 0 || feed.clips.length > 0;

  // 「新建一集」:当前集还是空的就直接去导入(它就是新的一集);有素材才真的封存 + 开新集。
  const createFresh = async () => {
    setBusy(true);
    setConfirmingNew(false);
    try {
      const outcome = await createEpisode(newEpisodeTitle());
      window.dispatchEvent(
        new CustomEvent("tripcut:episode-changed", { detail: { id: outcome.episode.id, title: outcome.episode.title } }),
      );
      openImport();
    } catch (error) {
      setNotice(episodeErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const startNew = () => {
    if (busy) return;
    setNotice(null);
    if (!currentHasClips) {
      openImport();
      return;
    }
    // 当前集有素材:新建集 = 封存当前集 —— 先确认,不让一次点击悄悄封存进行中的一集。
    setConfirmingNew(true);
  };

  // R15:删一集。删完后端告诉我们哪一集在进行中;派发 tripcut:episode-changed 让媒体池 /
  // 镜头带换范围(首页自己也听这个事件刷新卡片)。首页留在原地 —— 删错的集后下一步还是从这里开始。
  const removeEpisode = async (episode: EpisodeSummary) => {
    setBusy(true);
    try {
      const outcome = await deleteEpisode(episode.id);
      setDeleting(null);
      setNotice(
        outcome.created_fresh
          ? `已删除「${outcome.deleted.title}」,新开了空集「${outcome.active.title}」;原片没有动。`
          : `已删除「${outcome.deleted.title}」;现在在「${outcome.active.title}」;原片没有动。`,
      );
      window.dispatchEvent(
        new CustomEvent("tripcut:episode-changed", { detail: { id: outcome.active.id, title: outcome.active.title } }),
      );
    } catch (error) {
      setNotice(episodeErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const recent = recentEpisodes(episodes);
  const activeCover = feed.clips.find((clip) => clip.cover_url)?.cover_url ?? null;

  return (
    <section className="home-screen" aria-label="首页">
      <div className="home-scroll">
        <ol className="home-pipeline" role="group" aria-label="四步上手">
          {ONBOARDING_STEPS.map((step, index) => {
            const done = pipeline.done[index];
            const isCurrent = pipeline.step === index + 1;
            return (
              <li key={step.id} className={`home-pipeline-step${done ? " is-done" : ""}${isCurrent ? " is-current" : ""}`} aria-current={isCurrent ? "step" : undefined}>
                <span className="home-pipeline-index" aria-hidden="true">
                  {done ? <Icon name="check" size={12} /> : index + 1}
                </span>
                <span className="home-pipeline-copy">
                  <strong>{step.title}</strong>
                  <span>{step.body}</span>
                </span>
              </li>
            );
          })}
        </ol>

        <div className="home-hero">
          <p className="home-kicker">旅剪工作台</p>
          <h1 className="home-title">把这一趟旅行,剪成一集。</h1>
          <p className="home-lede">选一个装着视频的文件夹就能开始;分析都在本机完成,原片不会被改动。</p>
          <div className="home-actions">
            <Button variant="primary" icon="import" className="home-start" aria-label="新建一集" disabled={busy} onClick={startNew}>
              新建一集
            </Button>
            {currentHasClips ? (
              <Button variant="secondary" icon="play" aria-label="继续上次" title={current ? `回到「${current.title}」` : "回到工作区"} onClick={() => pinHome(false)}>
                继续上次
              </Button>
            ) : null}
          </div>
          {confirmingNew ? (
            <p className="home-confirm" role="status" aria-label="新建确认">
              <span>{`新建一集会先把当前集「${current?.title ?? "当前集"}」封存为只读档案。`}</span>
              <Button variant="secondary" size="sm" onClick={() => void createFresh()}>
                确认新建
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingNew(false)}>
                取消
              </Button>
            </p>
          ) : null}
          {notice ? (
            <p className="home-notice" role="status">
              {notice}
            </p>
          ) : null}
        </div>

        {/* R19 P-09(results 车道,这一块):三条预设句卡 —— 点了回到工作区、按那句挑一批(结果面板会说为什么)。 */}
        <div className="home-section">
          <h2 className="home-section-title">让软件先挑一版</h2>
          <PresetCards
            disabled={!currentHasClips}
            onPick={(preset) => {
              pinHome(false);
              window.dispatchEvent(new CustomEvent(SELECT_PROMPT_EVENT, { detail: { sentence: preset.sentence } }));
            }}
          />
        </div>

        {recent.length > 0 ? (
          <div className="home-section">
            <h2 className="home-section-title">最近的集</h2>
            <ul className="home-episodes" aria-label="最近的集">
              {recent.map((episode) => (
                <EpisodeCard
                  key={episode.id}
                  episode={episode}
                  done={episodeProgress(episode, episode.status === "active" ? pipeline.done : null)}
                  coverUrl={episode.status === "active" ? activeCover : null}
                  onOpen={openEpisode}
                  onMore={(target, anchor) => setMenu({ episode: target, ...anchor })}
                />
              ))}
            </ul>
            {renaming ? (
              <EpisodeRenameInline
                episode={renaming}
                onSaved={(renamed) => {
                  setRenaming(null);
                  setNotice(`已改名为「${renamed.title}」`);
                  refresh();
                }}
                onCancel={() => setRenaming(null)}
                onError={setNotice}
              />
            ) : null}
            {deleting ? (
              <EpisodeDeleteConfirm
                episode={deleting}
                busy={busy}
                consequence={episodeDeleteConsequence(deleting, episodes)}
                onConfirm={() => void removeEpisode(deleting)}
                onCancel={() => setDeleting(null)}
              />
            ) : null}
            {menu ? (
              <EpisodeMenu
                menu={menu}
                onRename={(episode) => {
                  setRenaming(episode);
                  setDeleting(null);
                  setNotice(null);
                }}
                onDelete={(episode) => {
                  setDeleting(episode);
                  setRenaming(null);
                  setNotice(null);
                }}
                onClose={() => setMenu(null)}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
