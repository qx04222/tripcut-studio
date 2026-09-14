import { useId, type JSX } from "react";
import type { TargetPlatform } from "../../api";
import { Badge, Button, Card, Chip, Field, SectionHeader, Select, Toggle, type BadgeTone } from "../ui";
import {
  PLATFORM_LABELS,
  PLATFORM_OPTIONS,
  ROUGH_CUT_TARGET_LABELS,
  ROUGH_CUT_TARGET_OPTIONS,
  roughCutTargetFromKey,
  roughCutTargetKey,
} from "./deliverModel";
import type { DeliverForm as DeliverFormState } from "./useDeliverForm";
import type { ExportOrientation } from "./useExportCanvas";
import { DELIVER_ORIENTATION_LABEL, ORIENTATION_LABEL } from "../copy";

const ORIENTATION_OPTIONS: ReadonlyArray<{ value: ExportOrientation; label: string }> = [
  { value: "landscape", label: "横版" },
  { value: "portrait", label: "竖版" },
];

export interface DeliverFormProps {
  form: DeliverFormState;
  /** 剪映草稿开关(抽屉本地状态:打开时主按钮走 generateNative)。 */
  useJianyingDraft: boolean;
  onUseJianyingDraftChange(next: boolean): void;
}

/** 剪映一行的状态字:后端 reason 原样(「已检测到剪映专业版 11.4」/ 拒绝原因),没有就按版本号拼。 */
function jianyingStatusText(form: DeliverFormState): string {
  if (form.jianying.reason) return form.jianying.reason;
  if (form.jianying.installed_version) return `已检测到剪映 ${form.jianying.installed_version}`;
  return "未检测到剪映";
}

/** 剪映一行的角标:未装 → 未检测;装了但版本没人工核对 → 待核对;可用 → 版本号。 */
function jianyingBadge(form: DeliverFormState): { tone: BadgeTone; text: string } {
  if (!form.jianying.installed_version) return { tone: "neutral", text: "未检测" };
  if (!form.jianying.supported) return { tone: "warn", text: "待核对" };
  return { tone: "accent", text: form.jianying.installed_version };
}

/** R14 §9 A:待验证版本的试验开关。AX 名「仍然试着生成」;可见文案带「(试验)」。 */
export const FORCE_DRAFT_LABEL = "仍然试着生成";
const FORCE_DRAFT_LINE = "试验草稿只新增一份、用新名字;就算剪映打不开,也不影响剪映里已有的草稿。";

/** 交付目标(平台 / 时长)+ 输出格式(联系表 / 剪映草稿)两节(规格 §4.2 第 1 条)。 */
export function DeliverForm({ form, useJianyingDraft, onUseJianyingDraftChange }: DeliverFormProps): JSX.Element {
  const platformId = useId();
  const targetId = useId();
  const contactId = useId();
  const jianyingId = useId();

  return (
    <>
      <section className="deliver-section" aria-labelledby={`${platformId}-section`}>
        <SectionHeader
          title={<span id={`${platformId}-section`}>交付目标</span>}
          meta={`本集设置:${PLATFORM_LABELS[form.episodePlatform]}`}
        />
        <Card className="deliver-fields" padding={4}>
          <Field label="本次交付平台" htmlFor={platformId} help="只影响本次输出的画面尺寸与清晰度">
            <Select
              id={platformId}
              aria-label="本次交付平台"
              value={form.overridePlatform}
              onChange={(event) => form.setOverridePlatform(event.currentTarget.value as TargetPlatform)}
            >
              {PLATFORM_OPTIONS.map((platform) => (
                <option key={platform} value={platform}>
                  {PLATFORM_LABELS[platform]}
                  {platform === form.episodePlatform ? "(本集设置)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          {/* R10 U-05:横/竖切换只覆盖本次交付(不写集记录);当前高亮 = 后端现算的画布方向。 */}
          <Field label={ORIENTATION_LABEL} help={form.canvas ? `${form.canvas.width}×${form.canvas.height}` : "按集设置 / 平台习惯 / 素材多数自动"}>
            <div className="deliver-orientation" role="group" aria-label={DELIVER_ORIENTATION_LABEL}>
              {ORIENTATION_OPTIONS.map((option) => (
                <Chip
                  key={option.value}
                  selected={(form.overrideOrientation ?? form.canvas?.orientation) === option.value}
                  onClick={() => form.setOverrideOrientation(option.value)}
                >
                  {option.label}
                </Chip>
              ))}
            </div>
          </Field>
          <Field label="参考粗剪时长" htmlFor={targetId} help="按平台时长预算预选">
            <Select
              id={targetId}
              aria-label="参考粗剪时长"
              value={roughCutTargetKey(form.targetSeconds)}
              onChange={(event) => form.setTargetSeconds(roughCutTargetFromKey(event.currentTarget.value))}
            >
              {ROUGH_CUT_TARGET_OPTIONS.map((option) => (
                <option key={roughCutTargetKey(option)} value={roughCutTargetKey(option)}>
                  {ROUGH_CUT_TARGET_LABELS[roughCutTargetKey(option)]}
                </option>
              ))}
            </Select>
          </Field>
        </Card>
      </section>

      <section className="deliver-section" aria-labelledby={`${contactId}-section`}>
        <SectionHeader title={<span id={`${contactId}-section`}>输出格式</span>} />
        <Card className="deliver-switch-rows" padding={4}>
          <div className="deliver-switch-row">
            <div className="deliver-switch-copy">
              <label className="deliver-switch-title" htmlFor={contactId}>
                联系表.pdf
              </label>
              <p className="deliver-switch-help">A4 网格联系表:封面缩略图 + 序号 / 入出点 / 章节,按本次交付平台的画面方向排横版或竖版</p>
            </div>
            <Toggle id={contactId} label="联系表.pdf" checked={form.includeContactSheet} onChange={form.setIncludeContactSheet} />
          </div>
          <div className="deliver-switch-row">
            <div className="deliver-switch-copy">
              <span className="deliver-switch-title-row">
                <label className="deliver-switch-title" htmlFor={jianyingId}>
                  剪映草稿
                </label>
                <Badge tone={jianyingBadge(form).tone}>{jianyingBadge(form).text}</Badge>
              </span>
              <p className="deliver-switch-help">
                <span>{jianyingStatusText(form)}</span>
                {form.jianying.supported ? <span> · 只新增一份草稿,不改剪映既有草稿;自检不过会自动降级为稳定包</span> : null}
              </p>
              {!form.jianying.supported && form.jianying.force_allowed ? (
                <div className="deliver-force-draft">
                  <p className="deliver-switch-help">{FORCE_DRAFT_LINE}</p>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={FORCE_DRAFT_LABEL}
                    busy={form.nativeBusy}
                    disabled={form.nativeBusy}
                    onClick={() => void form.generateExperimental()}
                  >
                    我知道风险,仍然试着生成(试验)
                  </Button>
                </div>
              ) : null}
            </div>
            <Toggle
              id={jianyingId}
              label="剪映草稿"
              checked={useJianyingDraft && form.jianying.supported}
              disabled={!form.jianying.supported}
              onChange={onUseJianyingDraftChange}
            />
          </div>
        </Card>
      </section>
    </>
  );
}
