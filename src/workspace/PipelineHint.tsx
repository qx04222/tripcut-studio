import { useCallback, useEffect, useState, type JSX } from "react";

import { getSettings, setSetting } from "../api";
import { PIPELINE_STEP_MARKS, type PipelineStep } from "./pipelineModel";
import { Button, Icon } from "./ui";
import { readUiBool } from "./uiSettings";
import { usePipeline } from "./usePipeline";

/** 设置键:`pipeline.hint_seen.<n>`(Rust `ONBOARDING_FLAG_KEYS` 白名单)。 */
export function hintSeenKey(step: PipelineStep): string {
  return `pipeline.hint_seen.${step}`;
}

export const PIPELINE_HINTS: Readonly<Record<PipelineStep, string>> = {
  1: "选一个装着视频的文件夹就行,原片不会被改动;分析在本机跑,不上传。",
  2: "在媒体池按 F 收藏喜欢的、1–5 打星;或直接点右上角「下一步:自动挑选」。",
  3: "挑好的片段排进镜头带后,拖一下镜块就能换顺序;章节有缺口就补一条。",
  4: "点「下一步:导出」,片段会导到你选的文件夹;要整包就切「完整交付包」。",
};

/**
 * 纯判定:该不该为当前步出提示。`seen` 为 null = 设置还没读回来(不出,免得闪一下)。
 * 会话内点过「知道了」的步也不再出(哪怕写设置失败)。
 */
export function hintStepToShow(step: PipelineStep, seen: ReadonlySet<string> | null, dismissed: ReadonlySet<PipelineStep>): PipelineStep | null {
  if (seen === null) return null;
  if (dismissed.has(step) || seen.has(hintSeenKey(step))) return null;
  return step;
}

/**
 * R12 §1:每步**首次进入**时,导航条下方一条可关的提示。状态由流水线推导(当前步变了就换句),
 * 「知道了」写 `pipeline.hint_seen.n`,下次启动不再出。不是模态、不抢焦点。
 * AX:`status` 名「第 n 步提示」;按钮「知道了」。
 */
export function PipelineHint(): JSX.Element | null {
  const pipeline = usePipeline();
  const [seen, setSeen] = useState<ReadonlySet<string> | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<PipelineStep>>(() => new Set());

  useEffect(() => {
    let active = true;
    getSettings()
      .then((settings) => {
        if (!active) return;
        const next = new Set<string>();
        for (const step of [1, 2, 3, 4] as const) {
          if (readUiBool(settings ?? {}, hintSeenKey(step))) next.add(hintSeenKey(step));
        }
        setSeen(next);
      })
      .catch(() => {
        // 读不到设置就当全看过 —— 宁可少一条提示,不能每次启动都重复出现。
        if (active) setSeen(new Set([1, 2, 3, 4].map((step) => hintSeenKey(step as PipelineStep))));
      });
    return () => {
      active = false;
    };
  }, []);

  const step = hintStepToShow(pipeline.step, seen, dismissed);

  const dismiss = useCallback(() => {
    if (step === null) return;
    setDismissed((previous) => new Set([...previous, step]));
    void setSetting(hintSeenKey(step), "true").catch(() => undefined);
  }, [step]);

  if (step === null) return null;
  return (
    <div className="pipeline-hint" role="status" aria-label={`第 ${step} 步提示`}>
      <Icon name="info" size={16} className="pipeline-hint-icon" />
      <p className="pipeline-hint-text">
        <strong>{`第 ${PIPELINE_STEP_MARKS[step]} 步`}</strong>
        <span>{PIPELINE_HINTS[step]}</span>
      </p>
      <Button variant="ghost" size="sm" onClick={dismiss}>
        知道了
      </Button>
    </div>
  );
}
