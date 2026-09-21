import { useEffect, useState, type JSX } from "react";
import { DELIVER_DRAWER_TITLE } from "./copy";
import { onJianyingAvailabilityChanged } from "./deliver/jianyingHumanCheck";
import { JIANYING_BUNDLE_ID, getJianyingAvailability, openApp, type JianyingAvailability } from "../api";
import {
  DELIVER_CARDS,
  DELIVER_CARD_HINTS,
  DELIVER_CARD_LABELS,
  HANDOFF_DOWNGRADE_LINE,
  HANDOFF_KIT_TOAST,
  MORE_WAYS_LABEL,
  cardToExportMode,
  type DeliverCard,
} from "./deliver/deliverCards";
import { DeliverContents, DeliverPartsDetails } from "./deliver/DeliverContents";
import { DeliverFooter } from "./deliver/DeliverFooter";
import { DeliverForm } from "./deliver/DeliverForm";
import { DeliverProgressCard } from "./deliver/DeliverProgressCard";
import { DeliverResultCard, JianyingResultCard } from "./deliver/DeliverResultCard";
import { PLATFORM_LABELS, canvasLabel, isExportActive, readCanvas } from "./deliver/deliverModel";
import { ExportExtras, ExportStepHead } from "./deliver/ExportStepHead";
import { JianyingKitFooter, JianyingKitPanel } from "./deliver/JianyingKitPanel";
import { QuickExportFooter, QuickExportPanel } from "./deliver/QuickExportPanel";
import { takePendingExportMode } from "./deliver/exportModeRequest";
import { EXPORT_MODES_R14, defaultExportMode } from "./deliver/kitExportModel";
import {
  DEFAULT_EXPORT_MODE,
  EXPORT_MODE_HINTS,
  EXPORT_MODE_LABELS,
  hasPendingQuickSelection,
  jianyingChipLabel,
  jianyingUnavailableLine,
  type ExportMode,
} from "./deliver/quickExportModel";
import { useDeliverForm } from "./deliver/useDeliverForm";
import { CANVAS_SOURCE_LABELS } from "./deliver/useExportCanvas";
import { useExportProgress, type ExportProgress } from "./deliver/useExportProgress";
import { useJianyingKit } from "./deliver/useJianyingKit";
import { useQuickExport } from "./deliver/useQuickExport";
import { returnToActiveEpisode } from "../historyView";
import { failureText } from "./errorText";
import { RETURN_TO_EXPORT_LABEL } from "./TopBar";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { Chip } from "./ui/Chip";
import { Drawer } from "./ui/Drawer";
import { showToast } from "./ui/Toast";
import { EXPORT_DONE_EVENT } from "./usePipeline";
import { dispatchWorkspace, useWorkspace, type WorkspaceState } from "./WorkspaceStore";

function close(): void {
  dispatchWorkspace({ type: "close-drawer" });
}

/**
 * 交付抽屉「完整交付包 / 剪映草稿」正文(规格 §4.2):副标题 → 交付目标 / 输出格式 / 内容 三节 →
 * 进度卡或结果卡 → 「交付包里有什么」折叠段;页脚 取消 / 开始生成。逻辑全在两个 hook 里,这里只是皮。
 * `mode = "jianying"` 时剪映草稿强制打开(R12 §6 的第三枚 chip);`forceContactSheet` 来自
 * 「导出片段」模式里勾了「也顺便…联系表」后切过来的那一下。
 */
function FullDeliverBody({ progress, mode, forceContactSheet }: { progress: ExportProgress; mode: "full" | "jianying"; forceContactSheet: boolean }): JSX.Element {
  const form = useDeliverForm(progress);
  const { setUseJianyingDraft, setIncludeContactSheet } = form;
  // 剪映模式不写 ui.deliver.jianying_draft(那是「完整交付包」里那枚开关的记忆),只在本次强制打开。
  const hasPhotos = (progress.status.selected_photo_count ?? 0) > 0;
  const hasVideos = progress.status.selected_segment_count + progress.status.selected_whole_count > 0;
  const useJianyingDraft = !hasPhotos && (mode === "jianying" ? form.jianying.supported : form.useJianyingDraft);
  useEffect(() => {
    // 等记住的选择读回来再压上去,否则会被那一次异步回填盖掉。
    if (forceContactSheet && form.loaded) setIncludeContactSheet(true);
  }, [forceContactSheet, form.loaded, setIncludeContactSheet]);
  const { status } = progress;
  const active = isExportActive(status);
  // R13 §5 交接感:草稿一落地就给一条「已生成剪映草稿 · 打开剪映」(open_app 只放行剪映的 bundle id)。
  const { nativeResult } = form;
  useEffect(() => {
    if (!nativeResult) return;
    showToast(JIANYING_DONE_TOAST, {
      tone: "success",
      durationMs: JIANYING_DONE_TOAST_MS,
      action: {
        label: OPEN_JIANYING_LABEL,
        onClick: () => {
          void openApp(JIANYING_BUNDLE_ID).catch((error) =>
            showToast(`${failureText("打开剪映", error, "")}草稿在 ${nativeResult.output_path}`, { tone: "danger" }),
          );
        },
      },
    });
  }, [nativeResult]);
  // 画布(U-05 / U-20):优先后端现算的 previewExportCanvas(带来源);读不到再回落导出状态 / 预设上的可选 canvas 字段。
  const canvasSize = form.canvas ?? readCanvas(status, form.preset);
  const canvas = form.canvas
    ? `${canvasLabel(form.canvas)} · ${CANVAS_SOURCE_LABELS[form.canvas.orientation_source]}`
    : canvasLabel(canvasSize);
  const subtitle = [form.episodeTitle || "当前集", `交付给${PLATFORM_LABELS[form.overridePlatform]}`, canvas, "保存到你选择的文件夹"]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <>
      <div className="deliver-drawer-scroll">
        <p className="deliver-subtitle">{subtitle}</p>
        <DeliverForm hasPhotos={hasPhotos} hasVideos={hasVideos} form={form} useJianyingDraft={useJianyingDraft} onUseJianyingDraftChange={setUseJianyingDraft} />
        <DeliverContents
          status={status}
          includeContactSheet={form.includeContactSheet}
          useJianyingDraft={useJianyingDraft && form.jianying.supported}
          targetSeconds={form.targetSeconds}
          canvas={canvasSize}
        />
        {form.nativeResult ? <JianyingResultCard result={form.nativeResult} /> : null}
        {active ? <DeliverProgressCard status={status} /> : <DeliverResultCard status={status} onReveal={() => void form.reveal()} />}
        <DeliverPartsDetails canvas={canvasSize} photoCount={status.selected_photo_count ?? 0} hasVideos={hasVideos} />
      </div>
      <DeliverFooter form={form} status={status} useJianyingDraft={useJianyingDraft && form.jianying.supported} onClose={close} />
    </>
  );
}

/** 「导出片段」正文——清单 + 「导出」,没有平台 / 粗剪 / 联系表 / 剪映;「也顺便…」勾了就切到完整交付包。 */
function QuickExportBody({ progress, onExtra }: { progress: ExportProgress; onExtra(kind: "contact" | "shots"): void }): JSX.Element {
  const quick = useQuickExport(progress);
  const { done } = quick;
  useEffect(() => {
    // 导出完成 → 流水线第 ④ 步当场打勾(usePipeline 听这个事件),不等集记录的 export_count 刷新。
    if (done) window.dispatchEvent(new CustomEvent(EXPORT_DONE_EVENT));
  }, [done]);
  return (
    <>
      <div className="deliver-drawer-scroll">
        <QuickExportPanel quick={quick} status={progress.status} />
        <ExportExtras onPick={onExtra} />
      </div>
      <QuickExportFooter quick={quick} status={progress.status} onClose={close} />
    </>
  );
}

/** R14 §9 B:「剪映素材包」正文——编号清单 + 「导出素材包」;导完广播 export-done 打勾第 ④ 步。 */
function JianyingKitBody({ progress, autoStart = false }: { progress: ExportProgress; autoStart?: boolean }): JSX.Element {
  const kit = useJianyingKit(progress, { autoStart });
  const { done } = kit;
  useEffect(() => {
    if (done) window.dispatchEvent(new CustomEvent(EXPORT_DONE_EVENT));
  }, [done]);
  return (
    <>
      <div className="deliver-drawer-scroll">
        <JianyingKitPanel kit={kit} status={progress.status} />
      </div>
      <JianyingKitFooter kit={kit} status={progress.status} onClose={close} />
    </>
  );
}

/** R13 §5 → R14 §9 B:四模式顺序「剪映草稿 / 剪映素材包 / 导出片段 / 完整交付包」。 */
export const MODES: readonly ExportMode[] = EXPORT_MODES_R14;
const CHECKING_JIANYING: JianyingAvailability = { installed_version: null, supported: false, reason: "" };
export const JIANYING_DONE_TOAST = "已生成剪映草稿";
export const OPEN_JIANYING_LABEL = "打开剪映";
const JIANYING_DONE_TOAST_MS = 10_000;

/**
 * 抽屉打开时落在哪个模式(R13 §5 / R14 §9 B):镜头带右上按钮点过来 → 它要的模式;「导出所选…」点过来 → 导出片段;
 * 否则剪映可用(白名单版本)默认剪映草稿,不可用默认剪映素材包。前两种在挂载时就定;第三种要等可用性回来。
 */
export function initialExportMode(pending: ExportMode | null, quickSelectionPending: boolean, jianying: JianyingAvailability | null): ExportMode | null {
  if (pending) return pending;
  if (quickSelectionPending) return "quick";
  return defaultExportMode(jianying);
}

/**
 * 抽屉本体(R12 §6):顶部「第 ④ 步」一句 + 三枚模式 chip「剪映草稿」/「导出片段」/「完整交付包」
 * (剪映不可用时带「(待验证)」+ 一句白话);轮询共用一份(换模式不丢进行中的任务;任务进行中 chip 禁用)。
 */
/**
 * Z-14:只读查看已封存集时抽屉不给任何导出入口 —— 后端的导出命令只认当前集,从旧集视角点「导出」
 * 会把当前集的镜导出去。一句话 + 「回到当前集再导出」(同时关抽屉)。
 */
function ReadOnlyDeliverBody({ title }: { title: string }): JSX.Element {
  return (
    <div className="deliver-drawer">
      <ExportStepHead />
      <Card className="deliver-readonly" padding={4} role="status" aria-label="只读集不能导出">
        <p className="deliver-readonly-title">{`正在只读查看「${title}」,导出只对当前集做`}</p>
        <p className="deliver-readonly-body">这一集已封存;要再导一次,先回到当前集,或在切换集里把它设为当前集。</p>
        <Button
          variant="primary"
          icon="deliver"
          aria-label={RETURN_TO_EXPORT_LABEL}
          onClick={() => {
            returnToActiveEpisode();
            close();
          }}
        >
          {RETURN_TO_EXPORT_LABEL}
        </Button>
      </Card>
    </div>
  );
}

/**
 * U-06/P-04(规格 §3 deliver 行、§7 Q-6 已拍板三卡):导出首屏三张大卡——
 * 「交给剪映」(内部按版本可用性自动选草稿/素材包,不给用户选)、「导出视频文件」、「整包交付」。
 * 「试验草稿 + 人工确认」(= 既有四模式 chip 选择器,AX 名冻结不变)收进「更多方式 ⌄」。
 */
function ExportCardsScreen({
  availability,
  photoCount,
  hasVideos,
  onPick,
  onMore,
}: {
  availability: JianyingAvailability;
  photoCount: number;
  hasVideos: boolean;
  onPick(card: DeliverCard): void;
  onMore(): void;
}): JSX.Element {
  return (
    <div className="deliver-cards" role="group" aria-label="交付方式">
      {DELIVER_CARDS.map((card) => (
        <button
          key={card}
          type="button"
          className="deliver-card"
          aria-label={DELIVER_CARD_LABELS[card]}
          onClick={() => onPick(card)}
        >
          <span className="deliver-card-title">{DELIVER_CARD_LABELS[card]}</span>
          <span className="deliver-card-hint">
            {card === "full" && !hasVideos
              ? photoCount > 0
                ? "照片 + 镜头表 + 说明"
                : "暂无交付项 · 请先挑选素材"
              : DELIVER_CARD_HINTS[card]}
            {deliverCardPhotoSuffix(card, photoCount)}
          </span>
        </button>
      ))}
      {!availability.supported ? (
        <p className="deliver-cards-downgrade" role="status">
          {HANDOFF_DOWNGRADE_LINE}
        </p>
      ) : null}
      <button type="button" className="deliver-cards-more" aria-label={MORE_WAYS_LABEL} onClick={onMore}>
        {MORE_WAYS_LABEL} ⌄
      </button>
    </div>
  );
}

export function deliverCardPhotoSuffix(card: DeliverCard, photoCount: number): string {
  return photoCount > 0 && card !== "quick" ? ` · ${photoCount} 张照片一起交付` : "";
}

function DeliverDrawerBody(): JSX.Element {
  const progress = useExportProgress();
  const [chosen, setMode] = useState<ExportMode | null>(() => initialExportMode(takePendingExportMode(), hasPendingQuickSelection(), null));
  // 首屏是三卡;deep-link(镜头带按钮 / 导出所选…)或点过一张卡 / 「更多方式」之后落到既有四模式详情页。
  const [screen, setScreen] = useState<"cards" | "detail">(() => (chosen !== null ? "detail" : "cards"));
  const [forceContactSheet, setForceContactSheet] = useState(false);
  const [jianying, setJianying] = useState<JianyingAvailability | null>(null);
  // R19 §6:只有首屏「交给剪映」落到素材包时才一次即出;「更多方式」/ chip / deep-link 进来的照旧等一次点击。
  const [autoKit, setAutoKit] = useState(false);
  const active = isExportActive(progress.status);
  // 没人指定模式时按可用性定默认;可用性还没回来先按「导出片段」画(chip 一回来就换,通常一帧内)。
  const photoCount = progress.status.selected_photo_count ?? 0;
  const hasVideos = progress.status.selected_segment_count + progress.status.selected_whole_count > 0;
  const requestedMode = chosen ?? initialExportMode(null, false, jianying) ?? DEFAULT_EXPORT_MODE;
  const mode: ExportMode = photoCount > 0 && requestedMode === "jianying" ? "kit" : requestedMode;
  const availability = jianying ?? CHECKING_JIANYING;

  const pickCard = (card: DeliverCard): void => {
    const resolved = card === "handoff" && photoCount > 0 ? "kit" : cardToExportMode(card, jianying);
    if (card === "handoff" && resolved === "kit") {
      showToast(HANDOFF_KIT_TOAST, { tone: "neutral" });
    }
    setAutoKit(card === "handoff" && resolved === "kit");
    setMode(resolved);
    setScreen("detail");
  };

  useEffect(() => {
    let alive = true;
    getJianyingAvailability()
      .then((availability) => {
        if (alive && availability && typeof availability === "object" && "supported" in availability) setJianying(availability);
      })
      .catch(() => undefined);
    // R14 A:人工验证「可以用」后 chip 与提示随可用性广播即时刷新。
    const stop = onJianyingAvailabilityChanged((next) => {
      if (alive) setJianying(next);
    });
    return () => {
      alive = false;
      stop();
    };
  }, []);

  // V14-03:传 force_allowed,待验证版本的顶行才会与下面的「仍然试着生成」说同一件事。
  const hint =
    mode === "jianying" && !availability.supported
      ? jianyingUnavailableLine(availability.installed_version, availability.force_allowed === true)
      : mode === "full" && !hasVideos
        ? photoCount > 0
          ? "照片 + 镜头表 + 说明"
          : "暂无交付项 · 请先挑选素材"
      : EXPORT_MODE_HINTS[mode];

  return (
    <div className="deliver-drawer">
      <ExportStepHead />
      {screen === "cards" ? (
        <ExportCardsScreen photoCount={photoCount} hasVideos={hasVideos} availability={availability} onPick={pickCard} onMore={() => setScreen("detail")} />
      ) : (
        <>
          <div className="deliver-mode" role="group" aria-label="导出方式">
            {MODES.map((candidate) => (
              <Chip
                key={candidate}
                selected={mode === candidate}
                disabled={active}
                aria-label={EXPORT_MODE_LABELS[candidate]}
                onClick={() => {
                  setAutoKit(false);
                  setMode(candidate);
                }}
              >
                {candidate === "jianying" ? jianyingChipLabel(availability.supported) : EXPORT_MODE_LABELS[candidate]}
              </Chip>
            ))}
          </div>
          <p className={mode === "jianying" && !availability.supported ? "deliver-mode-hint deliver-mode-hint--warn" : "deliver-mode-hint"} role="status">
            {hint}
          </p>
          {mode === "kit" ? (
            <JianyingKitBody progress={progress} autoStart={autoKit} />
          ) : mode === "quick" ? (
            <QuickExportBody
              progress={progress}
              onExtra={(kind) => {
                if (kind === "contact") setForceContactSheet(true);
                setMode("full");
              }}
            />
          ) : (
            <FullDeliverBody progress={progress} mode={mode === "jianying" ? "jianying" : "full"} forceContactSheet={forceContactSheet} />
          )}
        </>
      )}
    </div>
  );
}

/** 交付抽屉:从右侧滑入,宽 min(720, 60vw)(规格 §1、§4.2)。标题 dialog 名「导出」(X-05 由冻结名「生成交付包」解冻改名,见 design-system §11)。 */
export function DeliverDrawer(): JSX.Element | null {
  const open = useWorkspace((state: WorkspaceState) => state.openDrawer === "deliver");
  const viewingEpisode = useWorkspace((state: WorkspaceState) => state.viewingEpisode);

  return (
    <Drawer open={open} title={DELIVER_DRAWER_TITLE} side="right" width="min(720px, 60vw)" onClose={close}>
      {open ? viewingEpisode ? <ReadOnlyDeliverBody title={viewingEpisode.title} /> : <DeliverDrawerBody /> : null}
    </Drawer>
  );
}
