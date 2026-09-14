import { useCallback, useEffect, useRef, useState, type FormEvent, type JSX } from "react";

import { addTag, listTags, removeTag, type ClipTag } from "../api";
import { failureText } from "./errorText";
import { Button, Chip, Icon } from "./ui";

/**
 * R16 P2-10:检查器「标签」段真能加删。AI 标签与用户标签一起列;用户标签 chip 带 ×,
 * AI 标签没有 ×(后端也拒绝删;「隐藏」要加列,留到下一轮)。「添加标签」→ 行内输入框,
 * 回车提交、Esc 收起;`onCount` 把条数报给父级(段标题的「n 个」与段可见性)。
 */
export function InspectorTags({ clipId, readOnly = false, onCount }: { clipId: number; readOnly?: boolean; onCount?: (count: number) => void }): JSX.Element {
  const [tags, setTags] = useState<ClipTag[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const onCountRef = useRef(onCount);
  onCountRef.current = onCount;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const publish = useCallback((next: ClipTag[]) => {
    setTags(next);
    onCountRef.current?.(next.length);
  }, []);

  useEffect(() => {
    setTags(null);
    setAdding(false);
    setDraft("");
    setNotice(null);
    let active = true;
    Promise.resolve()
      .then(() => listTags(clipId))
      .then((next) => {
        if (active && mounted.current) publish(next ?? []);
      })
      .catch(() => {
        if (active && mounted.current) publish([]);
      });
    return () => {
      active = false;
    };
  }, [clipId, publish]);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setNotice(null);
    addTag(clipId, text)
      .then((tag) => {
        if (!mounted.current) return;
        const current = tags ?? [];
        publish(current.some((item) => item.id === tag.id) ? current : [...current, tag]);
        setDraft("");
      })
      .catch((error) => {
        if (mounted.current) setNotice(failureText("添加标签", error));
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  const remove = (tag: ClipTag) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    removeTag(clipId, tag.id)
      .then(() => {
        if (mounted.current) publish((tags ?? []).filter((item) => item.id !== tag.id));
      })
      .catch((error) => {
        if (mounted.current) setNotice(failureText("删除标签", error));
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  const list = tags ?? [];
  return (
    <div className="inspector-tag-list inspector-tags-r16">
      {tags !== null && list.length === 0 && !adding ? <span className="inspector-tag-empty">还没有标签;自己加,或生成 AI 描述会写入 3 个</span> : null}
      {list.map((tag) =>
        tag.deletable && !readOnly ? (
          <span key={tag.id} className="ui-chip ui-chip--neutral inspector-tag-chip" data-source={tag.source}>
            <span className="ui-chip-label">{tag.label}</span>
            <button type="button" className="inspector-tag-remove" aria-label={`删除标签 ${tag.label}`} disabled={busy} onClick={() => remove(tag)}>
              <Icon name="x" size={12} />
            </button>
          </span>
        ) : (
          <Chip key={tag.id} className="inspector-tag-chip" data-source={tag.source} title={tag.source === "user" ? undefined : "AI 生成的标签;重新生成描述会替换"}>
            {tag.label}
          </Chip>
        ),
      )}
      {readOnly ? null : adding ? (
        <form className="inspector-tag-form" onSubmit={submit}>
          <input
            ref={inputRef}
            className="inspector-tag-input"
            aria-label="新标签"
            placeholder="输入标签,回车添加"
            maxLength={32}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setAdding(false);
                setDraft("");
              }
            }}
          />
          <Button size="sm" variant="ghost" type="submit" disabled={busy || draft.trim() === ""} aria-label="确认添加标签">
            添加
          </Button>
          <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => { setAdding(false); setDraft(""); }}>
            收起
          </Button>
        </form>
      ) : (
        <Button variant="ghost" size="sm" icon="plus" className="inspector-tag-add" onClick={() => setAdding(true)}>
          添加标签
        </Button>
      )}
      {notice ? (
        <p className="inspector-notice" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
