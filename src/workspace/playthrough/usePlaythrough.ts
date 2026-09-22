import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayerStatus } from '../../api';
import { playthroughProgress, type PlaythroughSegment } from './model';
import { PLAYTHROUGH_RELEASE_EVENT, PLAYTHROUGH_TRIM_SEEK_EVENT } from './store';

export interface PlaythroughDeps {
  segments: readonly PlaythroughSegment[];
  selectedClipId: number | null;
  status: PlayerStatus | null;
  enabled: boolean;
  selectClip(id: number): void;
  transport: {
    seekTo(seconds: number, options?: { source: 'playthrough' | 'band-trim' }): Promise<boolean>;
    play(): Promise<void>;
    pause(): Promise<void>;
  };
}
export type PlaythroughPhase = 'idle' | 'playing' | 'paused' | 'done';
type Stage = 'stopping' | 'loading' | 'seeking' | 'frame' | 'starting' | 'running' | 'finished';
interface Session {
  phase: PlaythroughPhase;
  index: number;
  stage: Stage;
  segments: readonly PlaythroughSegment[];
  token: number;
  startedAt: number;
  switchMs: number | null;
  error: string | null;
}
const initial = (): Session => ({ phase: 'idle', index: 0, stage: 'finished', segments: [], token: 0, startedAt: 0, switchMs: null, error: null });
const active = (s: Session) => s.phase === 'playing' || s.phase === 'paused';
export const PLAYTHROUGH_TIMEOUT_MS = 10_000;

/** 唯一命令出口是 MonitorTransport。每段有取消令牌,迟到的 pause/seek 不能重启已停止的连播。 */
export function usePlaythrough(deps: PlaythroughDeps) {
  const latest = useRef(deps); latest.current = deps;
  const session = useRef<Session>(initial());
  const [state, setState] = useState(session.current);
  const [loop, setLoop] = useState(false);
  const loopRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const publish = useCallback((patch: Partial<Session>) => {
    session.current = { ...session.current, ...patch };
    if (mounted.current) setState(session.current);
  }, []);
  const clearTimer = useCallback(() => { clearTimeout(timer.current); timer.current = undefined; }, []);
  // 修剪挂起:拖边修剪的跟随 seek 到来时连播转 paused,修剪落地(段列表变)后自动继续;取消修剪就停在 paused,由用户再按播放。
  const heldByTrim = useRef(false);
  const stop = useCallback((error: string | null = null, keepPlaying = false) => {
    const wasActive = active(session.current);
    heldByTrim.current = false;
    publish({ phase: 'idle', stage: 'finished', token: session.current.token + 1, error });
    clearTimer();
    if (wasActive && !keepPlaying) void latest.current.transport.pause().catch(() => undefined);
  }, [publish, clearTimer]);
  const valid = useCallback((token: number) => mounted.current && session.current.token === token && active(session.current), []);
  const fail = useCallback((token: number, error: unknown) => {
    if (valid(token)) stop(`连播已停止：${String(error).replace(/^Error:\s*/, '')}`);
  }, [stop, valid]);

  const enter = useCallback((index: number, list = session.current.segments, phase: PlaythroughPhase = session.current.phase) => {
    if (!latest.current.enabled || !list[index]) return;
    clearTimer();
    const token = session.current.token + 1;
    publish({ token, index, segments: list, phase: phase === 'paused' ? 'paused' : 'playing', stage: 'stopping', startedAt: performance.now(), error: null });
    timer.current = setTimeout(() => fail(token, '等待片段首帧超时'), PLAYTHROUGH_TIMEOUT_MS);
    void latest.current.transport.pause().then(() => {
      if (!valid(token)) return;
      // 先暂停旧源,再改变 selection;loading 只接受目标素材的 ready。
      publish({ stage: 'loading' });
      latest.current.selectClip(list[index]!.clipId);
    }).catch(error => fail(token, error));
  }, [clearTimer, publish, fail, valid]);
  const start = useCallback((index = 0) => enter(index, latest.current.segments, 'playing'), [enter]);

  useEffect(() => {
    const s = session.current;
    if (!active(s)) return;
    if (!deps.enabled) { stop(); return; }
    const segment = s.segments[s.index]!;
    // stopping/first loading render can still contain the previous selection.
    if (s.stage !== 'stopping' && deps.selectedClipId !== segment.clipId) {
      if (s.stage !== 'loading') stop();
      return;
    }
    const status = deps.status;
    if (!status || status.clip_id !== segment.clipId) return;
    if (status.phase === 'error') { stop(status.error ?? '播放器无法载入'); return; }
    if (status.phase === 'closed' && s.stage === 'running') { stop('播放器已关闭'); return; }
    if (status.phase !== 'ready') return;
    const token = s.token;
    if (s.stage === 'loading') {
      publish({ stage: 'seeking' });
      void deps.transport.seekTo(segment.inPoint, { source: 'playthrough' }).then(ok => {
        if (!valid(token)) return;
        if (!ok) { stop('播放器尚未就绪'); return; }
        publish({ stage: 'frame' });
      }).catch(error => fail(token, error));
      return;
    }
    if (s.stage === 'frame') {
      // ready 仍可能是 seek 前旧状态;只有位置落到入点的半帧内才允许开播。
      if (Math.abs(status.pos - segment.inPoint) > 0.5 / segment.fps + 1e-6) return;
      if (s.phase === 'paused') clearTimer();
      publish({ stage: s.phase === 'paused' ? 'running' : 'starting', switchMs: performance.now() - s.startedAt });
      if (s.phase === 'playing') void deps.transport.play().then(() => {
        if (valid(token)) { clearTimer(); publish({ stage: 'running' }); }
      }).catch(error => fail(token, error));
      return;
    }
    if (s.stage !== 'running' || s.phase !== 'playing') return;
    const atOut = status.pos >= segment.outPoint - 1 / segment.fps;
    const atClipEnd = status.duration > 0 && status.pos >= status.duration - 1 / segment.fps;
    if (!atOut && !atClipEnd) return;
    if (s.index + 1 < s.segments.length) { enter(s.index + 1); return; }
    if (loopRef.current) { enter(0); return; }
    publish({ phase: 'done', stage: 'finished' });
    void deps.transport.pause().then(() => {
      if (mounted.current && session.current.token === token && session.current.phase === 'done') {
        return latest.current.transport.seekTo(Math.max(segment.inPoint, segment.outPoint - 1 / segment.fps), { source: 'playthrough' });
      }
    }).catch(() => undefined);
  }, [deps, state, publish, valid, stop, fail, clearTimer, enter]);

  // Selection 变化单独观察:内部目标之外的人工切换即使发生在异步换源中也取消。
  useEffect(() => {
    const s = session.current;
    if (s.phase !== 'idle' && (!deps.enabled || deps.selectedClipId !== s.segments[s.index]?.clipId)) stop();
    // Only selection changes trigger this guard; enter itself doesn't count as manual selection.
  }, [deps.selectedClipId, deps.enabled, stop]);
  // 段列表变了(拖边修剪落地 / 移出 / 重排):按 key 换成新的入出点,当前段没了就停;修剪挂起中则继续。
  useEffect(() => {
    const s = session.current;
    if (!active(s) || s.segments === deps.segments) return;
    // 空列表是刷新途中的一瞬(refreshClipsFeed 期间故事板短暂为空),不是「段被移出」——
    // 照它停会让任何一次修剪 / 排入的刷新都掐掉连播(真机 R22-C 撞到)。
    if (deps.segments.length === 0) return;
    const key = s.segments[s.index]?.key;
    const index = deps.segments.findIndex(segment => segment.key === key);
    if (index < 0) { stop(); return; }
    publish({ segments: deps.segments, index });
    if (heldByTrim.current && s.phase === 'paused') {
      heldByTrim.current = false;
      const token = s.token;
      publish({ phase: 'playing' });
      if (s.stage === 'running') void latest.current.transport.play().catch(error => fail(token, error));
    }
  }, [deps.segments, publish, stop, fail]);

  useEffect(() => {
    const interrupt = () => stop();
    const release = () => stop(null, true);
    const hold = () => {
      const s = session.current;
      if (s.phase !== 'playing') return;
      heldByTrim.current = true;
      const token = s.token;
      publish({ phase: 'paused' });
      void latest.current.transport.pause().catch(error => fail(token, error));
    };
    window.addEventListener('tripcut:manual-seek', interrupt);
    window.addEventListener(PLAYTHROUGH_RELEASE_EVENT, release);
    window.addEventListener(PLAYTHROUGH_TRIM_SEEK_EVENT, hold);
    window.addEventListener('pagehide', interrupt);
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimer();
      session.current = { ...session.current, token: session.current.token + 1, phase: 'idle' };
      window.removeEventListener('tripcut:manual-seek', interrupt);
      window.removeEventListener(PLAYTHROUGH_RELEASE_EVENT, release);
      window.removeEventListener(PLAYTHROUGH_TRIM_SEEK_EVENT, hold);
      window.removeEventListener('pagehide', interrupt);
    };
  }, [stop, clearTimer, publish, fail]);
  const pause = useCallback(() => {
    if (!active(session.current)) return;
    const token = session.current.token;
    publish({ phase: 'paused' });
    void latest.current.transport.pause().catch(error => fail(token, error));
  }, [publish, fail]);
  const resume = useCallback(() => {
    if (session.current.phase !== 'paused') return;
    const token = session.current.token;
    publish({ phase: 'playing' });
    if (session.current.stage === 'running') void latest.current.transport.play().catch(error => fail(token, error));
  }, [publish, fail]);
  const segment = state.segments[state.index];
  const progress = playthroughProgress(state.segments, state.index, state.phase === 'done' ? segment?.outPoint ?? 0 :
    state.stage === 'running' && deps.status?.clip_id === segment?.clipId ? deps.status?.pos ?? 0 : segment?.inPoint ?? 0);
  return {
    phase: state.phase, index: state.index, segment, total: state.segments.length, active: active(state),
    switching: active(state) && state.stage !== 'running', loop, switchMs: state.switchMs, error: state.error, ...progress,
    start, stop, pause, resume,
    next: () => { if (active(session.current)) enter(Math.min(session.current.segments.length - 1, session.current.index + 1)); },
    previous: () => { if (active(session.current)) enter(Math.max(0, session.current.index - 1)); },
    toggleLoop: () => { loopRef.current = !loopRef.current; setLoop(loopRef.current); },
  };
}
export type PlaythroughController = ReturnType<typeof usePlaythrough>;
