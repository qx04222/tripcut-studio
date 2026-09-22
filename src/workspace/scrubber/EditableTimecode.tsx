import { useEffect, useRef, useState } from "react";
import { formatTimecode } from "../../PlayerOverlay";
import { parseTimecode, timecode } from "./model";
export function EditableTimecode({ seconds, fps, duration, onSeek, disabled }: {
  seconds: number; fps: number; duration: number; disabled: boolean; onSeek(seconds: number): void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
  const close = () => { setEditing(false); requestAnimationFrame(() => button.current?.focus()); };
  return editing ? <input ref={input} className="scrubber-r22-time-input" aria-label="输入时间码" aria-invalid={invalid}
    title="分:秒.帧 或 秒.帧，回车跳转，Esc 取消" value={text} onChange={e => { setText(e.target.value); setInvalid(false); }}
    onBlur={() => setEditing(false)} onKeyDown={e => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); close(); }
      if (e.key === "Enter") {
        e.preventDefault(); const value = parseTimecode(text, fps);
        if (value === null || value > duration) { setInvalid(true); return; }
        onSeek(value); close();
      }
    }} /> : <button ref={button} type="button" className="scrubber-r22-time" aria-label="当前时间码" disabled={disabled}
      title={formatTimecode(seconds, fps)} onClick={() => { setText(timecode(seconds, fps, true)); setInvalid(false); setEditing(true); }}>
      {timecode(seconds, fps, true)}
    </button>;
}
