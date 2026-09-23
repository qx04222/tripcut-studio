import { Button } from '../ui';
import { playthroughTime } from './model';
import { requestPlaythrough, usePlaythroughSegments, usePlaythroughView } from './store';
import type { PlaythroughController } from './usePlaythrough';

export function PlaythroughButton() {
  const segments = usePlaythroughSegments();
  const view = usePlaythroughView();
  return <Button variant="secondary" size="sm" aria-label={view?.active && view.mode === 'band' ? '停止连播' : '镜头带连播'}
    disabled={segments.length === 0} title="镜头带连播 ⌘⇧P" onClick={() => requestPlaythrough()}>
    {view?.active && view.mode === 'band' ? '停止连播' : '连播'}
  </Button>;
}
export function PlaythroughStatus() {
  const view = usePlaythroughView();
  if (!view?.active) return null;
  const label = view.mode === 'selection' ? `选段${view.total > 1 ? ` ${view.index + 1}/${view.total}` : ''}` : `连播 ${view.index + 1}/${view.total}`;
  return <span>{`${label} · ${playthroughTime(view.elapsed)} / ${playthroughTime(view.duration)}`}</span>;
}
export function PlaythroughOverlay({ controller: c }: { controller: PlaythroughController }) {
  const selection = c.mode === 'selection';
  const label = selection ? '选段' : '连播';
  return <div className="playthrough-overlay" role="group" aria-label="镜头带连播预览" data-switch-ms={c.switchMs}>
    <div className="playthrough-row">
      <span>{`${label}${selection && c.total <= 1 ? '' : ` · 第 ${c.index + 1}/${c.total} 段`} · 章 ${c.segment?.chapter ?? '—'}`}</span>
      <Button variant="ghost" size="sm" aria-label="上一段" disabled={c.index === 0} onClick={c.previous}>上一段</Button>
      <Button variant="ghost" size="sm" aria-label="下一段" disabled={c.index + 1 === c.total} onClick={c.next}>下一段</Button>
      <Button variant="ghost" size="sm" aria-label="停止连播" title={selection ? "结束选段" : undefined} onClick={() => c.stop()}>停止</Button>
      <Button variant="ghost" size="sm" aria-label="循环镜头带" aria-pressed={c.loop} onClick={c.toggleLoop}>循环</Button>
    </div>
    <div className="playthrough-progress" role="progressbar" aria-label="镜头带总进度"
      aria-valuetext={selection && c.total <= 1 ? label : `${label} 第 ${c.index + 1}/${c.total} 段`} aria-valuemin={0} aria-valuemax={c.duration} aria-valuenow={c.elapsed}>
      <span style={{ width: `${c.duration > 0 ? c.elapsed / c.duration * 100 : 0}%` }} />
    </div>
  </div>;
}
