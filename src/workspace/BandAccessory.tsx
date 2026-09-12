import { useEffect, useMemo, useState, type JSX } from "react";

import { JourneyTimeline } from "../JourneyTimeline";
import { MusicPanel } from "../MusicPanel";
import { DestinationCardEditor, narrateEpisodeWithConsent } from "../Storyboard";
import { listStoryTemplates, type StoryTemplate, type StoryTemplateInfo } from "../api";
import { BAND_VIEWS, type BandView } from "./shotBandModel";
import { Button, Card, Chip, EmptyState, SectionHeader } from "./ui";
import { refreshClipsFeed, useClipsFeed } from "./useClipsFeed";
import { dispatchWorkspace, useWorkspace, type BandMode } from "./WorkspaceStore";

export { MusicRuler, rulerMarks, MUSIC_RULER_HEIGHT, RULER_SEGMENT_WIDTH } from "./MusicRuler";

/** 规格 §7 冻结的五个 tab 名,一字不差。 */
export const BAND_TABS: readonly { mode: BandMode; label: string }[] = [
  { mode: "story", label: "故事" },
  { mode: "music", label: "音乐" },
  { mode: "journey", label: "旅程" },
  { mode: "destination", label: "地点卡" },
  { mode: "template", label: "模板" },
];

/** 分段控件本身。附属区展不展开由 `BandAccessory` 决定,这一条永远在。 */
export function BandTabs(): JSX.Element {
  const bandMode = useWorkspace((state) => state.bandMode);
  return (
    <div className="band-tabs" role="tablist" aria-label="镜头带附属视图">
      {BAND_TABS.map((tab) => (
        <button
          type="button"
          role="tab"
          key={tab.mode}
          id={`band-tab-${tab.mode}`}
          aria-selected={bandMode === tab.mode}
          aria-controls="band-accessory"
          tabIndex={bandMode === tab.mode ? 0 : -1}
          className={bandMode === tab.mode ? "active" : undefined}
          onClick={() => dispatchWorkspace({ type: "set-band-mode", mode: tab.mode })}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/**
 * C 稿的镜头带视图切换「按章节 / 按时间 / 仅缺口」:一组 `Chip` 按钮(aria-pressed),
 * 挨着附属 tablist 放。它不是 tab —— tablist 名与五个 tab 是冻结的 AX 锚点,不往里加。
 */
export function BandViewToggle({ value, onChange }: { value: BandView; onChange: (view: BandView) => void }): JSX.Element {
  return (
    <div className="band-views" role="group" aria-label="镜头带视图">
      {BAND_VIEWS.map((item) => (
        <Chip key={item.view} selected={value === item.view} onClick={() => onChange(item.view)}>
          {item.label}
        </Chip>
      ))}
    </div>
  );
}

function TemplatePicker(): JSX.Element {
  const feed = useClipsFeed();
  const [templates, setTemplates] = useState<StoryTemplateInfo[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = feed.storyboard?.current_template ?? null;
  // 只读历史集不许重排 —— 与 MusicPanel / DestinationCardEditor 同一条判定。
  // 漏掉它就会在一个归档的集子上真的发一次 LLM 调用(花钱且改不回来)。
  const readOnly = feed.episode.viewing !== null;

  useEffect(() => {
    let active = true;
    void listStoryTemplates()
      .then((next) => {
        if (active) setTemplates(next);
      })
      // 模板卡是锦上添花;取不到就不渲染,不阻塞附属带本身(沿用 Storyboard 的处置)。
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const pick = async (template?: StoryTemplate) => {
    if (busy || readOnly) return;
    setBusy(true);
    try {
      // 知情同意/预算/provider 三道关卡在 Storyboard 里只有一份,这里复用它。
      const result = await narrateEpisodeWithConsent(template);
      if (result.kind === "cancelled") return;
      setNotice(result.notice);
      if (result.kind === "done") await refreshClipsFeed(true);
    } catch (error) {
      setNotice(`未创建叙事编排任务：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  // 模板卡 = 套件 `Card as="button"`(选中态自带 aria-pressed,与旧按钮同一份 AX 语义)。
  const none = (
    <Card as="button" interactive selected={current === null} className="band-template-card" disabled={busy || readOnly} onClick={() => void pick(undefined)}>
      <strong>不使用模板</strong>
      <span>按拍摄时间顺序,不做叙事重排</span>
    </Card>
  );
  return (
    <div className="band-templates">
      {templates.length === 0 ? (
        <EmptyState icon="settings-timeline" size="inline" title="没有可用的故事模板" body="模板清单没有载入;仍可按拍摄时间顺序编排。" action={none} />
      ) : (
        <div className="band-template-cards">
          {none}
          {templates.map((info) => (
            <Card
              as="button"
              interactive
              key={info.id}
              selected={current === info.id}
              className="band-template-card"
              disabled={busy || readOnly}
              onClick={() => void pick(info.id)}
            >
              <strong>{info.name_zh}</strong>
              <span>{info.blurb_zh}</span>
            </Card>
          ))}
        </div>
      )}
      {readOnly ? <p className="read-only-notice">历史集为只读档案</p> : null}
      {notice ? (
        <p className="band-accessory-notice" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

function DestinationEditor(): JSX.Element {
  const feed = useClipsFeed();
  const selection = useWorkspace((state) => state.selection);
  const [notice, setNotice] = useState<string | null>(null);
  const cards = feed.storyboard?.narrative?.destination_cards ?? [];

  // 「当前章节」:空槽位选中时直接给了章节;选中素材时按它在故事板里的归属找。
  const chapterId = useMemo(() => {
    if (selection?.kind === "slot") return selection.chapterId;
    if (selection?.kind === "clip") {
      return (
        feed.storyboard?.items.find((item) => item.clip_id === selection.clipId)?.chapter_id ?? null
      );
    }
    return null;
  }, [selection, feed.storyboard]);

  const card = cards.find((candidate) => candidate.chapter_id === chapterId) ?? cards[0] ?? null;

  if (!card) {
    return (
      <EmptyState
        icon="info"
        size="inline"
        title="本次编排没有识别出需要地点卡的重要叙事节点。"
        body="用故事模板重新编排后,重要地点会在这里生成可核实的地点卡。"
        action={
          <Button variant="secondary" size="sm" onClick={() => dispatchWorkspace({ type: "set-band-mode", mode: "template" })}>
            去编排故事
          </Button>
        }
      />
    );
  }
  return (
    <>
      <DestinationCardEditor
        card={card}
        disabled={feed.episode.viewing !== null}
        onSaved={async () => {
          await refreshClipsFeed(true);
        }}
        onNotice={setNotice}
      />
      {notice ? (
        <p className="band-accessory-notice" role="status">
          {notice}
        </p>
      ) : null}
    </>
  );
}

/**
 * 附属区。「故事」不展开(镜头带独占中下区,规格 §3.4),其余四种各自展开一块。
 * 音乐的 36px 刻度轨不在这里 —— 它在镜头带**上方**,由 `ShotBand` 直接渲染。
 */
export function BandAccessory(): JSX.Element | null {
  const bandMode = useWorkspace((state) => state.bandMode);
  const feed = useClipsFeed();
  if (bandMode === "story") return null;
  const title =
    bandMode === "music"
      ? "音乐与节奏"
      : bandMode === "journey"
        ? "旅程时间线"
        : bandMode === "destination"
          ? "地点卡"
          : "故事模板";
  const readOnly = feed.episode.viewing !== null;
  const journeyEmpty = (
    <EmptyState
      icon="import"
      size="inline"
      title="这一集还没有可排列的素材或地点卡。"
      body="导入素材后,会按拍摄日期排成一条旅程。"
      action={
        <Button
          variant="secondary"
          size="sm"
          icon="import"
          aria-haspopup="dialog"
          onClick={() => dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "source" })}
        >
          打开导入
        </Button>
      }
    />
  );
  return (
    <section
      className="band-accessory"
      id="band-accessory"
      data-testid="band-accessory"
      role="tabpanel"
      aria-labelledby={`band-tab-${bandMode}`}
    >
      {/* 音乐面板的栏标题条由 MusicPanel 自己画(「导入音乐」按钮的状态在它里面)。 */}
      {bandMode === "music" ? (
        <MusicPanel readOnly={readOnly} variant="band" />
      ) : (
        <>
          <SectionHeader size="pane" title={title} meta={readOnly ? "只读" : undefined} />
          <div className="band-accessory-body">
            {bandMode === "journey" ? <JourneyTimeline emptyState={journeyEmpty} /> : null}
            {bandMode === "destination" ? <DestinationEditor /> : null}
            {bandMode === "template" ? <TemplatePicker /> : null}
          </div>
        </>
      )}
    </section>
  );
}
