// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PlayerStatus } from '../../api';
import { usePlaythrough, type PlaythroughDeps } from './usePlaythrough';
import { playthroughProgress, type PlaythroughSegment } from './model';

const segments: PlaythroughSegment[] = [
  { key: 'a', clipId: 1, inPoint: 2, outPoint: 4, fps: 25, chapter: '1' },
  { key: 'b', clipId: 2, inPoint: 6, outPoint: 9, fps: 25, chapter: '2' },
];
const status = (clip_id = 1, pos = 0, paused = true): PlayerStatus => ({
  phase: 'ready', clip_id, pos, paused, duration: 20, frame: 1, error: null,
  seek_samples: 0, seek_p50_ms: null, seek_p95_ms: null, last_seek_ms: null,
});
function mount() {
  const transport = { pause: vi.fn(async () => {}), play: vi.fn(async () => {}), seekTo: vi.fn(async () => true), setEnd: vi.fn(async () => {}) };
  const selectClip = vi.fn();
  let props: PlaythroughDeps = { segments, selectedClipId: 1, status: status(), enabled: true, transport, selectClip };
  const hook = renderHook((p: PlaythroughDeps) => usePlaythrough(p), { initialProps: props });
  const update = async (patch: Partial<PlaythroughDeps>) => {
    props = { ...props, ...patch };
    await act(async () => hook.rerender(props));
  };
  const start = async (index = 0) => {
    await act(async () => hook.result.current.start(index));
    await update({ status: status(segments[index]!.clipId, segments[index]!.inPoint), selectedClipId: segments[index]!.clipId });
  };
  return { ...hook, transport, selectClip, update, start };
}
describe('R22 镜头带连播状态机', () => {
  it('先 seek 入点,等首帧状态到位再 play;到 out 减一帧暂停并换 clip,旧状态不能开播', async () => {
    const h = mount();
    await act(async () => h.result.current.start());
    expect(h.transport.seekTo).toHaveBeenCalledWith(2, { source: 'playthrough' });
    expect(h.transport.play).not.toHaveBeenCalled();
    await h.update({ status: status(1, 2) });
    expect(h.transport.play).toHaveBeenCalledTimes(1);
    await h.update({ status: status(1, 3.96, false) });
    expect(h.result.current.index).toBe(1);
    expect(h.selectClip).toHaveBeenLastCalledWith(2);
    expect(h.transport.pause).toHaveBeenCalled();
    await h.update({ selectedClipId: 2 });
    expect(h.transport.play).toHaveBeenCalledTimes(1);
    await h.update({ status: status(2, 0) });
    expect(h.transport.seekTo).toHaveBeenLastCalledWith(6, { source: 'playthrough' });
    await h.update({ status: status(2, 6) });
    expect(h.transport.play).toHaveBeenCalledTimes(2);
    expect(h.result.current.switchMs).toBeGreaterThanOrEqual(0);
  });
  it('最后一段 done 并停在 out 前最后一帧', async () => {
    const h = mount(); await h.start(1);
    await h.update({ status: status(2, 6) });
    await h.update({ status: status(2, 9, true) });
    expect(h.result.current.phase).toBe('done');
    expect(h.transport.seekTo).toHaveBeenLastCalledWith(8.96, { source: 'playthrough' });
  });
  it('暂停继续保留索引,前后跳段,循环默认关且打开后绕回首段', async () => {
    const h = mount(); await h.start();
    expect(h.result.current.loop).toBe(false);
    await act(async () => h.result.current.pause());
    expect(h.result.current.phase).toBe('paused');
    await act(async () => h.result.current.resume());
    expect(h.result.current.index).toBe(0);
    await act(async () => h.result.current.next());
    expect(h.result.current.index).toBe(1);
    await act(async () => h.result.current.previous());
    expect(h.result.current.index).toBe(0);
    await act(async () => h.result.current.toggleLoop());
    await h.start(1); await h.update({ status: status(2, 6) });
    await h.update({ status: status(2, 9, false) });
    expect(h.result.current.index).toBe(0);
    expect(h.result.current.phase).toBe('playing');
  });
  it('手动 seek、手动换素材、切工作台立即停止;退出清掉等待定时器', async () => {
    const h = mount(); await h.start();
    await act(async () => window.dispatchEvent(new Event('tripcut:manual-seek')));
    expect(h.result.current.phase).toBe('idle');
    await h.start(); await h.update({ selectedClipId: 99 });
    expect(h.result.current.phase).toBe('idle');
    await h.update({ selectedClipId: 1 }); await h.start();
    await h.update({ enabled: false });
    expect(h.result.current.phase).toBe('idle');
    h.unmount();
  });
  it('异步暂停未返回就停止,不能迟到换源;卸载也不能迟到开播', async () => {
    const h = mount();
    let resolve!: () => void;
    h.transport.pause.mockImplementationOnce(() => new Promise<void>(r => { resolve = r; }));
    act(() => h.result.current.start(1));
    await act(async () => h.result.current.stop());
    await act(async () => resolve());
    expect(h.selectClip).not.toHaveBeenCalled();
    h.unmount();
  });
  it('总进度只累加段的入出范围', () => {
    expect(playthroughProgress(segments, 1, 7)).toEqual({ elapsed: 3, duration: 5 });
    expect(playthroughProgress(segments, 1, 30).elapsed).toBe(5);
  });
});

it('同素材连续两段也先定位后播放,按段 key 保持独立索引', async () => {
  const h = mount();
  await h.update({ segments: [segments[0]!, { ...segments[1]!, clipId: 1 }] });
  await h.start();
  await h.update({ status: status(1, 3.96, false) });
  expect(h.result.current.index).toBe(1);
  expect(h.transport.seekTo).toHaveBeenLastCalledWith(6, { source: 'playthrough' });
  await h.update({ status: status(1, 6) });
  expect(h.transport.play).toHaveBeenCalledTimes(2);
  h.unmount();
});
it('停止或卸载释放唯一超时计时器;迟到 seek 不会 play', async () => {
  vi.useFakeTimers();
  const h = mount();
  let resolve!: (value: boolean) => void;
  h.transport.seekTo.mockImplementationOnce(() => new Promise<boolean>(r => { resolve = r; }));
  await act(async () => h.result.current.start());
  expect(vi.getTimerCount()).toBe(1);
  h.unmount();
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => resolve(true));
  expect(h.transport.play).not.toHaveBeenCalled();
  vi.useRealTimers();
});
it('换源失败/超时回 idle 并清理计时器', async () => {
  vi.useFakeTimers();
  const h = mount();
  await act(async () => h.result.current.start(1));
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(h.result.current.phase).toBe('idle');
  expect(h.result.current.error).toContain('超时');
  expect(vi.getTimerCount()).toBe(0);
  h.unmount(); vi.useRealTimers();
});

// R22-C 接线债(0.11.3)
describe('连播 × 镜头带编辑', () => {
  it('释放事件停连播但不暂停素材(与拖进度条同语义)', async () => {
    const h = mount(); await h.start();
    await h.update({ status: status(1, 3, false) });
    const pauses = h.transport.pause.mock.calls.length;
    await act(async () => window.dispatchEvent(new Event('tripcut:playthrough-release')));
    expect(h.result.current.phase).toBe('idle');
    expect(h.transport.pause.mock.calls.length).toBe(pauses);
    h.unmount();
  });
  it('连播中段列表变了按 key 换成新的入出点;当前段被移出则停', async () => {
    const h = mount(); await h.start();
    await h.update({ status: status(1, 3, false) });
    expect(h.result.current.index).toBe(0);
    await h.update({ segments: [{ ...segments[0]!, outPoint: 3.2 }, segments[1]!] });
    expect(h.result.current.segment?.outPoint).toBe(3.2);
    await h.update({ status: status(1, 3.2, false) });
    expect(h.result.current.index).toBe(1);
    await h.update({ selectedClipId: 2, status: status(2, 6) });
    await h.update({ segments: [segments[0]!] });
    expect(h.result.current.phase).toBe('idle');
    h.unmount();
  });
  it('刷新途中的空段列表不停连播(F-R22C-15)', async () => {
    const h = mount(); await h.start();
    await h.update({ status: status(1, 3, false) });
    await h.update({ segments: [] });
    expect(h.result.current.phase).toBe('playing');
    expect(h.result.current.segment?.key).toBe('a');
    await h.update({ segments });
    expect(h.result.current.phase).toBe('playing');
    h.unmount();
  });
  it('修剪跟随 seek 让连播挂起(暂停),修剪落地后按新出点继续', async () => {
    const h = mount(); await h.start();
    await h.update({ status: status(1, 3, false) });
    await act(async () => window.dispatchEvent(new Event('tripcut:trim-seek')));
    expect(h.result.current.phase).toBe('paused');
    expect(h.transport.pause).toHaveBeenCalledTimes(2);
    await h.update({ status: status(1, 3.5, true) });
    expect(h.result.current.index).toBe(0);
    await h.update({ segments: [{ ...segments[0]!, outPoint: 3.4 }, segments[1]!] });
    expect(h.result.current.phase).toBe('playing');
    expect(h.transport.play).toHaveBeenCalledTimes(2);
    await h.update({ status: status(1, 3.5, false) });
    expect(h.result.current.index).toBe(1);
    h.unmount();
  });
});

describe('R25 修剪出点围栏', () => {
  it('挂起后先等新 SetEnd 落地,再 Play', async () => {
    const h = mount(); await h.start();
    await act(async () => window.dispatchEvent(new Event('tripcut:trim-seek')));
    h.transport.play.mockClear(); h.transport.setEnd.mockClear();
    let finish!: () => void;
    h.transport.setEnd.mockImplementationOnce(() => new Promise<void>(r => { finish = r; }));
    await h.update({ segments: [{ ...segments[0]!, outPoint: 5 }, segments[1]!] });
    expect(h.transport.setEnd).toHaveBeenCalledWith(5);
    expect(h.transport.play).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(h.transport.play).toHaveBeenCalledTimes(1);
    expect(h.transport.setEnd.mock.invocationCallOrder[0]).toBeLessThan(h.transport.play.mock.invocationCallOrder[0]!);
    h.unmount();
  });
  it('running 当前段出点变更重挂但不 Play;其他段变化不重挂', async () => {
    const h = mount(); await h.start();
    h.transport.play.mockClear(); h.transport.setEnd.mockClear();
    await h.update({ segments: [segments[0]!, { ...segments[1]!, outPoint: 10 }] });
    expect(h.transport.setEnd).not.toHaveBeenCalled();
    await h.update({ segments: [{ ...segments[0]!, outPoint: 5 }, segments[1]!] });
    expect(h.transport.setEnd).toHaveBeenCalledExactlyOnceWith(5);
    expect(h.transport.play).not.toHaveBeenCalled();
    h.unmount();
  });
  it('围栏失败走 fail,停止连播且不 Play', async () => {
    const h = mount(); await h.start();
    await act(async () => window.dispatchEvent(new Event('tripcut:trim-seek')));
    h.transport.play.mockClear();
    h.transport.setEnd.mockRejectedValueOnce(new Error('fence failed'));
    await h.update({ segments: [{ ...segments[0]!, outPoint: 5 }, segments[1]!] });
    expect(h.result.current.phase).toBe('idle');
    expect(h.result.current.error).toContain('fence failed');
    expect(h.transport.play).not.toHaveBeenCalled();
    h.unmount();
  });
  it('等待 SetEnd 时 stop 使令牌过期,迟到完成不能 Play', async () => {
    const h = mount(); await h.start();
    await act(async () => window.dispatchEvent(new Event('tripcut:trim-seek')));
    h.transport.play.mockClear();
    let finish!: () => void;
    h.transport.setEnd.mockImplementationOnce(() => new Promise<void>(r => { finish = r; }));
    await h.update({ segments: [{ ...segments[0]!, outPoint: 5 }, segments[1]!] });
    await act(async () => h.result.current.stop());
    await act(async () => finish());
    expect(h.transport.play).not.toHaveBeenCalled();
    h.unmount();
  });
});
