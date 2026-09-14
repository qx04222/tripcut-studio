import { useCallback, useEffect, useState, type JSX } from "react";

import { createEpisode, deleteEpisode, listEpisodes, setSetting, type EpisodeSummary } from "../api";
import { episodeErrorMessage } from "../EpisodePanel";
import { EpisodeDeleteConfirm, episodeDeleteConsequence } from "./EpisodeDeleteConfirm";
import { EpisodeMenu, EpisodeRenameInline, type EpisodeMenuState } from "./EpisodeMenu";
import { EpisodeCard, TemplateCard } from "./HomeCards";
import { HOME_TEMPLATES, TEMPLATE_PRESELECT_KEY, episodeProgress, recentEpisodes, templateEpisodeTitle, type HomeTemplate } from "./homeModel";
import { pinHome } from "./homeStore";
import { ONBOARDING_STEPS } from "./onboarding";
import { Button, Icon } from "./ui";
import { useClipsFeed } from "./useClipsFeed";
import { usePipeline } from "./usePipeline";
import { useOccludesPlayer } from "./usePlayerOcclusion";
import { dispatchWorkspace } from "./WorkspaceStore";

/**
 * R13 §3(车道 B):剪映式首页。空库时自动出现,或点顶栏 logo 进来(homeStore)。
 * 一屏三件事:「开始一个新旅程」大按钮(= 打开导入抽屉)、「最近的集」卡片(切集并进工作区)、
 * 三个模板卡(新建集 + 预选模板 → 进工作区并打开导入)。R12 的四步卡并入顶部。
 * 唯一的 primary 是「开始一个新旅程」;卡片都是 Card as="button"。
 * AX:region「首页」/ button「开始一个新旅程」/ list「最近的集」/ group「从模板开始」/ status「模板确认」。
 */
export function HomeScreen(): JSX.Element {
  const feed = useClipsFeed();
  const pipeline = usePipeline();
  // Y-01:首页盖住整个工作区,原生 mpv 视图却画在 WKWebView 之上 —— 在场期间让它让位。
  useOccludesPlayer();
  const [episodes, setEpisodes] = useState<EpisodeSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingTemplate, setPendingTemplate] = useState<HomeTemplate | null>(null);
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
    return () => window.removeEventListener("tripcut:episode-changed", refresh);
  }, [refresh]);

  const startJourney = () => {
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

  const createFromTemplate = async (template: HomeTemplate) => {
    setBusy(true);
    setPendingTemplate(null);
    try {
      const outcome = await createEpisode(templateEpisodeTitle(template));
      // 预选模板:记在设置里(镜头带模板面板据此高亮),并把镜头带切到「模板」;素材导入后一点即套。
      void setSetting(TEMPLATE_PRESELECT_KEY, template.id).catch(() => undefined);
      dispatchWorkspace({ type: "set-band-mode", mode: "template" });
      window.dispatchEvent(
        new CustomEvent("tripcut:episode-changed", { detail: { id: outcome.episode.id, title: outcome.episode.title } }),
      );
      pinHome(false);
      dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "source" });
    } catch (error) {
      setNotice(episodeErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const pickTemplate = (template: HomeTemplate) => {
    if (busy) return;
    setNotice(null);
    // 当前集有素材:新建集 = 封存当前集 —— 先确认,不让一次点击悄悄封存别人的进行中。
    if (currentHasClips) {
      setPendingTemplate(template);
      return;
    }
    void createFromTemplate(template);
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
          <Button variant="primary" icon="import" className="home-start" aria-label="开始一个新旅程" onClick={startJourney}>
            开始一个新旅程
          </Button>
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

        <div className="home-section" role="group" aria-label="从模板开始">
          <h2 className="home-section-title">从模板开始</h2>
          <div className="home-templates">
            {HOME_TEMPLATES.map((template) => (
              <TemplateCard key={template.id} template={template} disabled={busy} onPick={pickTemplate} />
            ))}
          </div>
          {pendingTemplate ? (
            <p className="home-confirm" role="status" aria-label="模板确认">
              <span>{`用「${pendingTemplate.label}」开新集,会先把当前集「${current?.title ?? "当前集"}」封存为只读档案。`}</span>
              <Button variant="secondary" size="sm" onClick={() => void createFromTemplate(pendingTemplate)}>
                确认新建
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setPendingTemplate(null)}>
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
      </div>
    </section>
  );
}
