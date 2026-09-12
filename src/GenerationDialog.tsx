import { useCallback, useEffect, useRef, useState } from "react";

import {
  previewGeneration,
  submitGeneration,
  type GenerationAvailability,
  type GenerationDraftPreview,
  type GenerationOverrides,
  type StoryGap,
} from "./api";
import { useFocusTrap } from "./useFocusTrap";
import { isTopModal, popModal, pushModal } from "./workspace/modalStack";

const PROMPT_MAX = 7000;

const MODEL_RESOLUTIONS: Record<string, string[]> = {
  "MiniMax-H3-Max": ["480P", "768P"],
  "MiniMax-H3": ["768P", "2K"],
};

const REF_ROLE_LABELS: Record<string, string> = {
  first_frame: "首帧",
  last_frame: "末帧",
  reference_image: "参考图",
};

function refRoleLabel(role: string): string {
  return REF_ROLE_LABELS[role] ?? role;
}

interface GenerationDialogProps {
  gap: StoryGap;
  readOnly: boolean;
  availability: GenerationAvailability | null;
  onClose: () => void;
  onSubmitted: (gapId: number, summary: Awaited<ReturnType<typeof submitGeneration>>) => void;
}

/** R7 T6:「生成候选」对话框——提示词可编、参考帧预览、费用先见。 */
export function GenerationDialog({ gap, readOnly, availability, onClose, onSubmitted }: GenerationDialogProps) {
  const [preview, setPreview] = useState<GenerationDraftPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<string>("MiniMax-H3-Max");
  const [resolution, setResolution] = useState<string>("768P");
  const [duration, setDuration] = useState(6);
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const debounceTimerRef = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  useFocusTrap(dialogRef, true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    previewGeneration(gap.id, {})
      .then((next) => {
        if (!active) return;
        setPreview(next);
        setPrompt(next.prompt);
        setModel(next.model);
        setResolution(next.resolution);
        setDuration(next.duration_s);
      })
      .catch((cause) => {
        if (active) setError(`预览未载入：${String(cause)}`);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [gap.id]);

  // 对话框此前没有登记到模态栈,壳的全局 Esc 处理器会以为没有模态层打开,
  // 于是在对话框开着的时候继续退出沉浸模式/清空搜索。登记方式和
  // Drawer/CommandPalette/HelpOverlay 一致(R8 终审 L9)。
  const modalToken = useRef({});
  useEffect(() => {
    const token = modalToken.current;
    pushModal(token);
    return () => popModal(token);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!isTopModal(modalToken.current)) return;
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const refreshPreview = useCallback(
    (overrides: GenerationOverrides) => {
      previewGeneration(gap.id, overrides)
        .then((next) => {
          if (mounted.current) setPreview(next);
        })
        .catch((cause) => {
          if (mounted.current) setError(`预览未载入：${String(cause)}`);
        });
    },
    [gap.id],
  );

  const debouncedRefreshPreview = useCallback(
    (overrides: GenerationOverrides) => {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = window.setTimeout(() => {
        refreshPreview(overrides);
      }, 400);
    },
    [refreshPreview],
  );

  const onPromptChange = (value: string) => {
    setPrompt(value);
    debouncedRefreshPreview({ prompt: value, model, resolution, duration_s: duration });
  };

  const onModelChange = (value: string) => {
    const allowed = MODEL_RESOLUTIONS[value] ?? [];
    const nextResolution = allowed.includes(resolution) ? resolution : (allowed[0] ?? resolution);
    setModel(value);
    setResolution(nextResolution);
    debouncedRefreshPreview({ prompt, model: value, resolution: nextResolution, duration_s: duration });
  };

  const onResolutionChange = (value: string) => {
    setResolution(value);
    debouncedRefreshPreview({ prompt, model, resolution: value, duration_s: duration });
  };

  const onDurationChange = (value: number) => {
    setDuration(value);
    debouncedRefreshPreview({ prompt, model, resolution, duration_s: value });
  };

  const promptTooLong = prompt.length > PROMPT_MAX;
  const disabledReason = readOnly
    ? "历史集为只读档案"
    : availability && !availability.enabled
      ? "先在设置页启用云端补镜"
      : availability && !availability.has_key
        ? "尚未配置 MiniMax API Key"
        : promptTooLong
          ? "提示词超过 7000 字符上限"
          : null;
  const submitDisabled = !preview || loading || submitting || disabledReason !== null;

  const handleSubmit = async () => {
    if (submitDisabled || !preview) return;
    setSubmitting(true);
    setError(null);
    try {
      const summary = await submitGeneration(gap.id, { prompt, model, resolution, duration_s: duration });
      onSubmitted(gap.id, summary);
      onClose();
    } catch (cause) {
      if (mounted.current) setError(`提交失败：${String(cause)}`);
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  };

  const resolutionOptions = MODEL_RESOLUTIONS[model] ?? [];
  const costText = preview ? `约 $${preview.estimated_cost_usd.toFixed(2)}` : "…";

  return (
    <div
      className="generation-dialog-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="generation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="generation-dialog-title"
        ref={dialogRef}
      >
        <header>
          <h2 id="generation-dialog-title">生成候选 · {gap.slot_label_zh}</h2>
          <p>{gap.chapter_title} · {gap.reason}</p>
        </header>
        {readOnly ? <p className="read-only-notice">历史集为只读档案</p> : null}
        {loading ? <p className="generation-dialog-notice">正在生成预览…</p> : null}
        {error ? <p className="generation-dialog-notice" aria-live="polite">{error}</p> : null}
        {preview ? (
          <div className="generation-dialog-body">
            <label className="generation-prompt-field">
              <span>提示词</span>
              <textarea
                rows={5}
                value={prompt}
                disabled={readOnly}
                onChange={(event) => onPromptChange(event.currentTarget.value)}
              />
              <small className={promptTooLong ? "generation-prompt-count over" : "generation-prompt-count"}>
                {prompt.length} / {PROMPT_MAX}
              </small>
            </label>
            <div className="generation-dialog-selects">
              <label>
                <span>模型</span>
                <select value={model} disabled={readOnly} onChange={(event) => onModelChange(event.currentTarget.value)}>
                  {Object.keys(MODEL_RESOLUTIONS).map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>分辨率</span>
                <select
                  value={resolution}
                  disabled={readOnly}
                  onChange={(event) => onResolutionChange(event.currentTarget.value)}
                >
                  {resolutionOptions.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>时长 {duration}s</span>
                <input
                  type="range"
                  min={4}
                  max={15}
                  value={duration}
                  disabled={readOnly}
                  onChange={(event) => onDurationChange(Number(event.currentTarget.value))}
                />
              </label>
            </div>
            {preview.refs.length > 0 ? (
              <div className="generation-refs" aria-label="参考帧">
                {preview.refs.map((ref, index) => (
                  <figure key={`${ref.path}-${index}`}>
                    {ref.preview_url ? <img src={ref.preview_url} alt={refRoleLabel(ref.role)} /> : <div className="generation-ref-placeholder" />}
                    <figcaption>{refRoleLabel(ref.role)}</figcaption>
                  </figure>
                ))}
              </div>
            ) : null}
            {preview.notes.length > 0 ? (
              <ul className="generation-notes">
                {preview.notes.map((note, index) => <li key={index}>{note}</li>)}
              </ul>
            ) : null}
            <div className="generation-cost-row">
              <span>预计费用 {costText}</span>
              {availability ? <small>本月预算剩余 ${availability.budget_remaining_usd.toFixed(2)}</small> : null}
            </div>
          </div>
        ) : null}
        <footer>
          {disabledReason ? <small className="generation-disabled-hint">{disabledReason}</small> : null}
          <button type="button" onClick={onClose}>取消</button>
          <button type="button" disabled={submitDisabled} onClick={() => void handleSubmit()}>
            {submitting ? "提交中…" : `提交（${costText}）`}
          </button>
        </footer>
      </div>
    </div>
  );
}
