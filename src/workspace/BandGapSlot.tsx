import { useState, type JSX } from "react";

import type { GenerationAvailability, StoryGap } from "../api";
import { GENERATION_STATUS_LABELS } from "../Storyboard";
import { openGapPool } from "./band/gaps";
import { GapMoreMenu } from "./BandGapMenu";
import { slotIndexLabel } from "./BandSegmentLabel";
import { openSettings } from "./openSettings";
import { slotLabelZh } from "./shotBandModel";
import { Button, Icon, type MenuItem } from "./ui";

/**
 * 缺口卡(空槽位)及其判定 / 菜单项 —— R22-C 从 BandSegment.tsx 拆出来(给镜块文件腾行数,
 * 与 R13 拆 BandSegmentLabel / BandGapMenu 同一条理由);BandSegment.tsx 原样 re-export,导入路径不变。
 */

/**
 * 「生成候选」为什么按不了 —— 必须说出中文原因,不能是一个按了没反应的按钮
 * (规格 §3.3;R7 的 StoryGapCard 也是这套判定,文案在这里统一)。
 */
export function generationDisabledHint(
  availability: GenerationAvailability | null | undefined,
): string | null {
  // 命令报错/返回空都算「状态未知」——宽松判空,不让一个 undefined 把整栏打崩。
  if (availability === null || availability === undefined) return "云端补镜状态未知；稍后重试";
  if (!availability.enabled) return "云端补镜未启用；先在设置里启用";
  if (!availability.has_key) return "还没填云端补镜的密钥";
  if (availability.budget_remaining_usd <= 0) return "本月生成预算已用尽";
  return null;
}

/**
 * 打开设置 sheet 并请求跳到「云端补镜」分区(R10 U-17 的「去设置」链接)。设置 sheet 归
 * 车道 E;分区跳转通过一个自定义事件递过去,sheet 没接上事件时至少也打开了设置。
 */
export const OPEN_SETTINGS_SECTION_EVENT = "tripcut:open-settings-section";

/** 瓦片里只放得下一行:「云端补镜未启用；先在设置里启用」只留分号前半句,后半句由「去设置」链接代替。 */
export function shortDisabledHint(hint: string): string {
  return hint.split("；")[0] ?? hint;
}

export function openGenerationSettings(): void {
  // R10 接线:分区经 store 的 `settingsSection` 传给 sheet(车道 E 的 openSettings);事件保留给旧监听者。
  openSettings("generation");
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: { section: "generation" } }));
}

/** 缺口卡 / 空章卡的主动作(R12 §2):有挑好的片段 → 从里面选;没有 → 回到第 ② 步挑几条。 */
export function gapPrimaryAction(hasCandidates: boolean): { label: string; kind: "pick" | "back-to-select" } {
  return hasCandidates ? { label: "从挑好的片段里选", kind: "pick" } : { label: "回到第 2 步挑几条", kind: "back-to-select" };
}

/** 「···」菜单项(R12 §2:云端补镜降级到这里;未启用时禁用并把原因写在 AX 名里)。 */
export function gapMenuItems(disabledHint: string | null, includePick: boolean): MenuItem[] {
  const items: MenuItem[] = [];
  if (includePick) items.push({ id: "pick", label: "从挑好的片段里选" });
  // R22-C 第 6 项:「从池里填」—— 展开媒体池、按缺口类型预填搜索(band/gaps.ts 的 openGapPool)。
  items.push({ id: "pool", label: "从池里填" });
  items.push({
    id: "generate",
    label: "云端补镜生成候选",
    ariaLabel: "生成候选",
    disabled: disabledHint !== null,
  });
  if (disabledHint !== null) items.push({ id: "settings", label: `去设置（${shortDisabledHint(disabledHint)}）`, ariaLabel: "去设置" });
  items.push({ id: "dismiss", label: "忽略这个缺口", ariaLabel: "忽略" });
  return items;
}

/** 缺口卡的「···」在 BandGapMenu.tsx(R13 给镜块腾出行数);这里 re-export,导入路径不变。 */
export { GapMoreMenu };

/**
 * 空槽位卡片。**请求状态与只读态都必须分叉** —— 镜像 R7 的 `StoryGapCard`
 * (`src/Storyboard.tsx`):在飞的请求给「取消」、失败给「重新生成」+ 错误原文、
 * 已入库什么都不给,只读历史集里一律禁用并说明原因。少一条分叉,界面就会在
 * 一个已经排队的缺口上再给一次「生成候选」——那是重复付费。
 *
 * R12 §2:卡上只留**一个主动作**(从挑好的片段里选 / 回到第 2 步挑几条);云端补镜、
 * 忽略、去设置收进「···」。
 */
export function GapSlotBody({
  gap,
  slotIndex,
  readOnly,
  disabledHint,
  hasCandidates,
  onGenerate,
  onDismiss,
  onRetry,
  onCancel,
  onPickFromPool,
  onBackToSelect,
}: {
  gap: StoryGap;
  slotIndex: number;
  readOnly: boolean;
  disabledHint: string | null;
  /** 有没有挑好的片段可选(决定主动作是「从挑好的片段里选」还是「回到第 2 步挑几条」)。 */
  hasCandidates?: boolean;
  onGenerate: (gap: StoryGap) => void;
  onDismiss: (gapId: number) => void;
  onRetry: (requestId: number, gapId: number) => void;
  onCancel: (requestId: number) => void;
  /** 「从挑好的片段里选」:用真素材填这个槽位,不靠云端补镜。 */
  onPickFromPool?: () => void;
  /** 「回到第 2 步挑几条」:没有候选时的主动作。 */
  onBackToSelect?: () => void;
}): JSX.Element {
  // 缺口说明可展开(R10 U-30):默认一行省略,点一下展开成整段(再点收回)。
  const [reasonOpen, setReasonOpen] = useState(false);
  const request = gap.latest_request;
  const status = request?.status ?? null;
  const inFlight = status === "submitted" || status === "queued" || status === "succeeded";
  // 卡片本身可点(=选中这个槽位);按钮上的点击一律不能冒泡上去顺手换掉选择。
  const stop = (run: () => void) => (event: { stopPropagation(): void }) => {
    event.stopPropagation();
    run();
  };
  const primary = gapPrimaryAction(hasCandidates ?? Boolean(onPickFromPool));
  const runPrimary = primary.kind === "pick" ? onPickFromPool : onBackToSelect;
  const onMenu = (id: string) => {
    if (id === "pick") onPickFromPool?.();
    else if (id === "pool") openGapPool(gap);
    else if (id === "generate") onGenerate(gap);
    else if (id === "settings") openGenerationSettings();
    else if (id === "dismiss") onDismiss(gap.id);
  };

  return (
    <span className="band-slot">
      <span className="band-slot-title">
        <Icon name="warning" size={12} />
        <span className="band-slot-kicker">缺口 ·</span>
        <strong>{slotLabelZh(gap)}</strong>
      </span>
      <button
        type="button"
        className={reasonOpen ? "band-slot-reason is-open" : "band-slot-reason"}
        title={reasonOpen ? "收起说明" : gap.reason}
        aria-expanded={reasonOpen}
        onClick={stop(() => setReasonOpen((value) => !value))}
      >
        {/* R-08:截行打在 span 上 —— WebKit 的 <button> 不认 -webkit-box 的 line-clamp,原文会撑成四行把底行挤出卡片。 */}
        <span className="band-slot-reason-text">{gap.reason}</span>
      </button>
      {status ? (
        <small className={`band-slot-status band-slot-status-${status}`}>
          {GENERATION_STATUS_LABELS[status]}
          {status === "failed" && request?.error ? `：${request.error}` : ""}
        </small>
      ) : !readOnly ? (
        <small className="band-slot-index">{slotIndexLabel(slotIndex)}</small>
      ) : null}
      {status === "imported" ? null : inFlight ? (
        <span className="band-slot-buttons">
          <Button size="sm" disabled={readOnly} onClick={stop(() => request && onCancel(request.id))}>
            取消
          </Button>
        </span>
      ) : status === "failed" ? (
        <span className="band-slot-more">
          <Button size="sm" className="band-slot-primary" disabled={readOnly} onClick={stop(() => request && onRetry(request.id, gap.id))}>
            重新生成
          </Button>
          <GapMoreMenu items={gapMenuItems(disabledHint, Boolean(onPickFromPool)).filter((item) => item.id !== "generate")} disabled={readOnly} onSelect={onMenu} />
        </span>
      ) : (
        <span className="band-slot-more">
          <Button size="sm" className="band-slot-primary" disabled={readOnly || !runPrimary} onClick={stop(() => runPrimary?.())}>
            {primary.label}
          </Button>
          <GapMoreMenu items={gapMenuItems(disabledHint, false)} disabled={readOnly} onSelect={onMenu} />
        </span>
      )}
      {readOnly ? <small className="read-only-notice">历史集为只读档案</small> : null}
    </span>
  );
}
