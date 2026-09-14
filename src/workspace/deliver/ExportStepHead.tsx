import { useId, type JSX } from "react";
import { PIPELINE_STEP_MARKS } from "../pipelineModel";

/** R12 §6:导出抽屉顶部「第 ④ 步」一句 —— 告诉新手这是流水线的最后一步。 */
export function ExportStepHead(): JSX.Element {
  return (
    <p className="deliver-step">
      <span className="deliver-step-mark" aria-hidden="true">{PIPELINE_STEP_MARKS[4]}</span>
      <strong>第 4 步 · 导出</strong>
      <span>挑好、排好的片段从这里出去;导完这一集就算做完了。</span>
    </p>
  );
}

/**
 * 「也顺便…」两枚勾选(联系表 PDF、镜头表)。它们都是完整交付包里的东西,所以在「导出片段」
 * 模式下勾任何一个 = 切到「完整交付包」并把那一项带上(联系表本来就是那边的开关;镜头表
 * 完整包自带)。这里只是入口,不自己发命令。
 */
export function ExportExtras({ onPick }: { onPick(kind: "contact" | "shots"): void }): JSX.Element {
  const contactId = useId();
  const shotsId = useId();
  return (
    <fieldset className="deliver-extras">
      <legend className="deliver-extras-legend">也顺便…</legend>
      <label className="deliver-extra" htmlFor={contactId}>
        <input id={contactId} type="checkbox" checked={false} onChange={() => onPick("contact")} />
        <span>出一份联系表 PDF(封面缩略图 + 入出点)</span>
      </label>
      <label className="deliver-extra" htmlFor={shotsId}>
        <input id={shotsId} type="checkbox" checked={false} onChange={() => onPick("shots")} />
        <span>出一份镜头表(表格)</span>
      </label>
      <p className="deliver-extras-hint">勾上任意一项会切到「完整交付包」一起出。</p>
    </fieldset>
  );
}
