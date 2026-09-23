import { useState, type JSX } from "react";
import { JIANYING_BUNDLE_ID, openApp, type ExportStatus, type JianyingDraftResult } from "../../api";
import { describeError, failureText } from "../errorText";
import { Button, Card, Icon, showToast } from "../ui";
import { draftContentLine, ffmpegToolHintForItems, STAGE_LABELS } from "./deliverModel";
import { DeliverItemList } from "./DeliverProgressCard";
import { submitJianyingHumanCheck } from "./jianyingHumanCheck";

export interface DeliverResultCardProps {
  status: ExportStatus;
  onReveal(): void;
}

/** 完成 / 失败的结果卡(规格 §4.2 第 5 条):ok tint 带「打开文件夹」;danger tint 带错误原文。 */
export function DeliverResultCard({ status, onReveal }: DeliverResultCardProps): JSX.Element | null {
  const settled = status.status === "done" || status.status === "failed" || status.status === "blocked";
  if (!settled) return null;
  const failedItems = status.items.filter((item) => item.status === "failed");
  // R17 exportfix ⑤:失败原因是 ffmpeg 不认编码器 / 选项时,多一行「去哪儿看、怎么办」。
  const toolHint = ffmpegToolHintForItems(failedItems);
  const toolHintLine = toolHint ? <p className="deliver-result-tool-hint">{toolHint}</p> : null;
  if (status.status === "done") {
    return (
      <Card className="deliver-result deliver-result--ok" padding={4}>
        <span className="deliver-result-icon">
          <Icon name="check" size={16} />
        </span>
        <div className="deliver-result-copy">
          <p className="deliver-result-title">{STAGE_LABELS.complete}</p>
          <p className="deliver-result-meta">
            {status.completed_items} 项已写入{status.failed_items > 0 ? ` · ${status.failed_items} 项未成功` : ""}
          </p>
          {status.output_path ? <code className="deliver-result-path">{status.output_path}</code> : null}
          {toolHintLine}
        </div>
        {status.job_id !== null ? (
          <Button variant="secondary" size="sm" onClick={onReveal}>
            打开文件夹
          </Button>
        ) : null}
        <DeliverItemList items={failedItems} />
      </Card>
    );
  }
  return (
    <Card className="deliver-result deliver-result--danger" padding={4}>
      <span className="deliver-result-icon">
        <Icon name="warning" size={16} />
      </span>
      <div className="deliver-result-copy">
        <p className="deliver-result-title">{STAGE_LABELS.failed}</p>
        {status.error ? (
          <p className="deliver-result-meta" role="alert">
            {describeError(status.error)}
          </p>
        ) : null}
        {status.output_path ? <code className="deliver-result-path">{status.output_path}</code> : null}
        {toolHintLine}
      </div>
      <DeliverItemList items={failedItems} />
    </Card>
  );
}

/** 剪映草稿已生成:草稿名 + 回读自检信息 + 路径。不声称已打开剪映。试验草稿(R14 §9 A)另给三步 + 两个裁定按钮。 */
export function JianyingResultCard({ result }: { result: JianyingDraftResult }): JSX.Element {
  if (result.experimental) return <ExperimentalDraftCard result={result} />;
  return (
    <Card className="deliver-result deliver-result--ok" padding={4}>
      <span className="deliver-result-icon">
        <Icon name="check" size={16} />
      </span>
      <div className="deliver-result-copy">
        <p className="deliver-result-title">剪映草稿已生成</p>
        <p className="deliver-result-name">{result.draft_name}</p>
        <p className="deliver-result-meta">{draftContentLine(result)}</p>
        <p className="deliver-result-meta">{result.message}</p>
        <TimelineSubtitleLine result={result} />
        <p className="deliver-result-meta">{FOLDER_ACCESS_HINT}</p>
        <code className="deliver-result-path">{result.output_path}</code>
      </div>
    </Card>
  );
}

/** R27 真机:素材在桌面等受保护文件夹时,剪映第一次打开草稿会弹 macOS 授权框;点「不允许」会被系统永久记下。 */
export const FOLDER_ACCESS_HINT = "剪映第一次打开时,macOS 可能会问能不能访问素材所在的文件夹(比如桌面),请点「允许」;否则素材会显示离线。";

export const OPEN_JIANYING_LABEL = "打开剪映";
export const HUMAN_CHECK_OK_LABEL = "可以用";
export const HUMAN_CHECK_FAIL_LABEL = "打不开";

function TimelineSubtitleLine({ result }: { result: JianyingDraftResult }): JSX.Element | null {
  return result.subtitles_on_timeline === true ? (
    <p className="deliver-result-meta">字幕已写进时间线:{result.timeline_subtitle_count ?? 0} 条</p>
  ) : null;
}

/**
 * 试验草稿结果卡:「1 打开剪映 → 2 看草稿列表里有没有『<草稿名>』→ 3 能打开就点『可以用』,打不开点『打不开』」。
 * 裁定写进 settings `jianying.human_check.<version>` 并广播可用性;ok 之后这个版本视为已验证。
 */
function ExperimentalDraftCard({ result }: { result: JianyingDraftResult }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [recorded, setRecorded] = useState<"ok" | "fail" | null>(null);
  const verdict = async (value: "ok" | "fail") => {
    setBusy(true);
    try {
      if (await submitJianyingHumanCheck(result.jianying_version, value)) setRecorded(value);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="deliver-result deliver-result--ok deliver-result--experimental" padding={4}>
      <span className="deliver-result-icon">
        <Icon name="check" size={16} />
      </span>
      <div className="deliver-result-copy">
        <p className="deliver-result-title">试验草稿已写出,请到剪映里看一眼</p>
        <p className="deliver-result-meta">{draftContentLine(result)}</p>
        <TimelineSubtitleLine result={result} />
        <ol className="deliver-experimental-steps">
          <li>
            打开剪映
            <Button
              variant="secondary"
              size="sm"
              aria-label={OPEN_JIANYING_LABEL}
              onClick={() => void openApp(JIANYING_BUNDLE_ID).catch((error) => showToast(`${failureText("打开剪映", error, "")}草稿在 ${result.draft_path ?? result.output_path}`, { tone: "danger" }))}
            >
              {OPEN_JIANYING_LABEL}
            </Button>
          </li>
          <li>
            看草稿列表里有没有『<span className="deliver-result-name">{result.draft_name}</span>』
          </li>
          <li>
            能打开就点「可以用」,打不开点「打不开」
            {recorded ? (
              <span className="deliver-experimental-verdict deliver-experimental-verdict--done" role="status">
                已记下「{recorded === "ok" ? HUMAN_CHECK_OK_LABEL : HUMAN_CHECK_FAIL_LABEL}」
              </span>
            ) : (
              <span className="deliver-experimental-verdict">
                <Button variant="primary" size="sm" aria-label={HUMAN_CHECK_OK_LABEL} busy={busy} disabled={busy} onClick={() => void verdict("ok")}>
                  {HUMAN_CHECK_OK_LABEL}
                </Button>
                <Button variant="ghost" size="sm" aria-label={HUMAN_CHECK_FAIL_LABEL} disabled={busy} onClick={() => void verdict("fail")}>
                  {HUMAN_CHECK_FAIL_LABEL}
                </Button>
              </span>
            )}
          </li>
        </ol>
        <code className="deliver-result-path">{result.draft_path ?? result.output_path}</code>
      </div>
    </Card>
  );
}
