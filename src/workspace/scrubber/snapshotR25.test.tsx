// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestApiMock } from '../testApiMock';
vi.mock('../../api', async () => createTestApiMock());
import { MonitorControls } from '../MonitorControls';
import { __resetPlayerPrefsForTests } from '../playerPrefs';
import type { ClipListItem, PlayerStatus } from '../../api';
import { timecode } from './model';
beforeEach(() => { __resetPlayerPrefsForTests(); vi.stubGlobal('PointerEvent', MouseEvent); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each([30, 50, 60])('004/006: %i fps 暂停、拖动、步进与恢复使用同一个显示位置', fps => {
  const onSeek = vi.fn(), onNudge = vi.fn(), onPlayPause = vi.fn();
  const status = { phase: 'ready', clip_id: 1, pos: 5, duration: 100, paused: false } as PlayerStatus;
  const props = { clip: { id: 1, fps_num: fps, fps_den: 1 } as ClipListItem, status, inPoint: 20, outPoint: 30,
    notice: null, saving: false, muted: false, onSeek, onNudge, onPlayPause,
    onToggleMute: vi.fn(), onMarkIn: vi.fn(), onMarkOut: vi.fn(), onSaveSegment: vi.fn(), onRequestImmersive: vi.fn() };
  const view = render(<MonitorControls {...props} />);
  const slider = screen.getByRole('slider', { name: '播放位置' });
  const assertPosition = (pos: number) => {
    expect(slider.getAttribute('aria-valuenow')).toBe(String(pos));
    expect(slider.getAttribute('aria-valuetext')).toBe(timecode(pos, fps));
    expect(screen.getByLabelText('当前时间码').textContent).toBe(timecode(pos, fps, true));
    expect(Number.parseFloat(document.querySelector<HTMLElement>('.scrubber-r22-head')!.style.left)).toBeCloseTo(pos);
  };
  assertPosition(5);
  fireEvent.click(screen.getByRole('button', { name: '暂停' }));
  expect(onPlayPause).toHaveBeenCalledOnce();
  view.rerender(<MonitorControls {...props} status={{ ...status, paused: true }} />);
  vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 100 } as DOMRect);
  fireEvent.pointerDown(slider, { clientX: 40 });
  // 定位尚未解码时不外推,三处显示仍共用最后回读的位置。
  assertPosition(5);
  fireEvent.pointerUp(slider, { clientX: 40 });
  expect(onSeek).toHaveBeenLastCalledWith(40);
  view.rerender(<MonitorControls {...props} status={{ ...status, pos: 40, paused: true }} />);
  assertPosition(40);
  fireEvent.click(screen.getByRole('button', { name: '前进一秒' })); expect(onNudge).toHaveBeenLastCalledWith(1);
  view.rerender(<MonitorControls {...props} status={{ ...status, pos: 41, paused: true }} />); assertPosition(41);
  fireEvent.click(screen.getByRole('button', { name: '后退一秒' })); expect(onNudge).toHaveBeenLastCalledWith(-1);
  view.rerender(<MonitorControls {...props} status={{ ...status, pos: 40, paused: true }} />); assertPosition(40);
  fireEvent.click(screen.getByRole('button', { name: '播放' }));
  view.rerender(<MonitorControls {...props} status={{ ...status, pos: 40 + 1/fps }} />); assertPosition(40 + 1/fps);
});
