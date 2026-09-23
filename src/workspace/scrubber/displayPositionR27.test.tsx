// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestApiMock } from '../testApiMock';
vi.mock('../../api', async () => createTestApiMock());
import { MonitorControls, type MonitorControlsProps } from '../MonitorControls';
import { __resetPlayerPrefsForTests, writeScrubberView } from '../playerPrefs';
import type { ClipListItem, PlayerStatus } from '../../api';
import { timecode } from './model';

let now = 1000;
let frames: Map<number, FrameRequestCallback>;
let nextId = 0;
beforeEach(() => {
  __resetPlayerPrefsForTests(); now = 1000; frames = new Map();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++nextId, cb); return nextId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function tick(ms: number) {
  now += ms;
  act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(cb => cb(now)); });
}
function setup(fps = 60, overrides: Partial<MonitorControlsProps> = {}) {
  let props: MonitorControlsProps = {
    clip: { id: 1, fps_num: fps, fps_den: 1 } as ClipListItem,
    status: { phase: 'ready', clip_id: 1, pos: 5, duration: 100, paused: false } as PlayerStatus,
    inPoint: null, outPoint: null, notice: null, saving: false, muted: false,
    onSeek: vi.fn(), onNudge: vi.fn(), onPlayPause: vi.fn(), onToggleMute: vi.fn(),
    onMarkIn: vi.fn(), onMarkOut: vi.fn(), onSaveSegment: vi.fn(), onRequestImmersive: vi.fn(), ...overrides,
  };
  const view = render(<MonitorControls {...props} />);
  return { ...view, props, update(patch: Partial<MonitorControlsProps>) {
    props = { ...props, ...patch }; view.rerender(<MonitorControls {...props} />);
  } };
}
function assertPosition(pos: number, fps = 60, range = [0, 100]) {
  const slider = screen.getByRole('slider', { name: '播放位置' });
  expect(Number(slider.getAttribute('aria-valuenow'))).toBeCloseTo(pos, 8);
  expect(slider.getAttribute('aria-valuetext')?.split(' · ')[0]).toBe(timecode(pos, fps));
  expect(screen.getByLabelText('当前时间码').textContent).toBe(timecode(pos, fps, true));
  expect(parseFloat(document.querySelector<HTMLElement>('.scrubber-r22-head')!.style.left))
    .toBeCloseTo((pos - range[0]!) / (range[1]! - range[0]!) * 100, 8);
}
it.each([29.97, 30, 50, 59.94, 60])('R27 %s fps: 同一显示位置逐帧推进,暂停与新状态立即重锚', fps => {
  const h = setup(fps); assertPosition(5, fps);
  tick(40); assertPosition(5.04, fps);
  h.update({ status: { ...h.props.status!, pos: 5.01 } }); assertPosition(5.01, fps);
  tick(40); assertPosition(5.05, fps);
  h.update({ status: { ...h.props.status!, pos: 5.02, paused: true } });
  tick(200); assertPosition(5.02, fps);
  expect(h.props.onSeek).not.toHaveBeenCalled();
});
it.each(['full', 'zoom'] as const)('R27 %s 视图在围栏钳住,键盘命令仍从真实位置计算', async mode => {
  await writeScrubberView(mode);
  const h = setup(60, { playthrough: { inPoint: 4, outPoint: 5.06, index: 0, total: 1, mode: 'selection', stage: 'running' } });
  tick(40);
  const range = mode === 'zoom' ? [3.894, 5.166] : [0, 100];
  assertPosition(5.04, 60, range);
  const slider = screen.getByRole('slider', { name: '播放位置' });
  expect(Number(slider.getAttribute('aria-valuenow'))).toBeCloseTo(5.04);
  const before = parseFloat(document.querySelector<HTMLElement>('.scrubber-r22-head')!.style.left);
  tick(400);
  assertPosition(5.06, 60, range);
  expect(slider.getAttribute('aria-valuetext')).toBe(`${timecode(5.06, 60)} · 第 1/1 段`);
  expect(screen.getByLabelText('当前时间码').textContent).toBe(timecode(5.06, 60, true));
  const after = parseFloat(document.querySelector<HTMLElement>('.scrubber-r22-head')!.style.left);
  expect(after).toBeGreaterThan(before);
  tick(400); expect(parseFloat(document.querySelector<HTMLElement>('.scrubber-r22-head')!.style.left)).toBe(after);
  fireEvent.keyDown(slider, { key: 'ArrowRight' });
  expect(h.props.onSeek).toHaveBeenLastCalledWith(5 + 1 / 60);
});
it('R27 倍速推进,时长钳位,卸载取消 rAF', () => {
  const h = setup(60, { rate: 2 });
  tick(40); assertPosition(5.08);
  h.update({ status: { ...h.props.status!, pos: 99.99 } });
  tick(40); assertPosition(100);
  h.unmount(); expect(frames.size).toBe(0);
});
it.each(['seeking', 'rewinding', 'switching', 'loading-stage', 'loading', 'clip'] as const)('R27 %s 期间回状态位置,停止外推', mode => {
  const h = setup(); tick(40); assertPosition(5.04);
  if (mode === 'seeking') h.update({ seeking: true });
  if (mode === 'rewinding') h.update({ rewinding: true });
  if (mode === 'switching') h.update({ playthrough: { inPoint: 4, outPoint: 6, index: 0, total: 1, switching: true, stage: 'stopping' } });
  if (mode === 'loading-stage') h.update({ playthrough: { inPoint: 40, outPoint: 60, index: 1, total: 2, stage: 'loading' } });
  if (mode === 'loading') h.update({ status: { ...h.props.status!, phase: 'loading' } });
  if (mode === 'clip') h.update({ clip: { ...h.props.clip, id: 2 } });
  tick(200);
  // 换段 loading 阶段沿用 R24 P-2:读数落新段入点(40),其余阻断条件回实际状态位置;两者都不外推。
  expect(Number(screen.getByRole('slider', { name: '播放位置' }).getAttribute('aria-valuenow'))).toBe(mode === 'loading-stage' ? 40 : 5);
});

it('R27 相同 pos 的新状态也重锚,仅变倍速不重置收到状态的时刻', () => {
  const h = setup(); tick(40); assertPosition(5.04);
  h.update({ rate: 2 }); assertPosition(5.08);
  tick(20); assertPosition(5.12);
  h.update({ status: { ...h.props.status! } }); assertPosition(5);
  tick(40); assertPosition(5.08);
});
