// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestApiMock } from '../testApiMock';
vi.mock('../../api', async () => createTestApiMock());
import { PlaythroughButton, PlaythroughStatus, PlaythroughOverlay } from './PlaythroughOverlay';
import { publishPlaythrough, setPlaythroughSegments, requestPlaythrough, usePlaythroughCommands } from './store';
import { useMonitorTransport } from '../useMonitorTransport';
import { GUIDES } from '../guides';
import { ShotMenu } from '../BandSegmentMenu';
import type { ClipListItem, PlayerStatus } from '../../api';
import type { BandSegment } from '../shotBandModel';
import type { PlaythroughController } from './usePlaythrough';
const segment = { key: 's', clipId: 1, inPoint: 2, outPoint: 4, chapter: '1', fps: 25 };
const controller = () => ({ active: true, phase: 'playing', segment, index: 2, total: 12, elapsed: 42, duration: 187, loop: false,
  start: vi.fn(), stop: vi.fn(), pause: vi.fn(), resume: vi.fn(), next: vi.fn(), previous: vi.fn(), toggleLoop: vi.fn(),
} as unknown as PlaythroughController);
beforeEach(() => { setPlaythroughSegments([]); publishPlaythrough(null); });
afterEach(cleanup);
it('标题入口 AX 冻结,空带禁用,播放中变停止;状态条只一句', () => {
  const { rerender } = render(<><PlaythroughButton /><PlaythroughStatus /></>);
  expect(screen.getByRole('button', { name: '镜头带连播' }).hasAttribute('disabled')).toBe(true);
  act(() => { setPlaythroughSegments([segment]); publishPlaythrough(controller()); });
  rerender(<><PlaythroughButton /><PlaythroughStatus /></>);
  expect(screen.getByRole('button', { name: '停止连播' })).toBeTruthy();
  expect(screen.getByText('连播 3/12 · 00:42 / 03:07')).toBeTruthy();
});
it('叠层段数、总进度、上一段下一段停止以及循环', () => {
  const c = controller(); render(<PlaythroughOverlay controller={c} />);
  expect(screen.getByText('连播 · 第 3/12 段 · 章 1')).toBeTruthy();
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
  fireEvent.click(screen.getByRole('button', { name: '上一段' })); expect(c.previous).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '下一段' })); expect(c.next).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '停止连播' })); expect(c.stop).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '循环镜头带' })); expect(c.toggleLoop).toHaveBeenCalled();
});
it('⌘⇧P 和命令请求走同一入口,⌘Z 不拦截,编辑/IME 不触发', () => {
  const c = controller(); c.active = false;
  renderHook(() => usePlaythroughCommands(c, true));
  act(() => setPlaythroughSegments([segment]));
  fireEvent.keyDown(document, { key: 'P', metaKey: true, shiftKey: true });
  expect(c.start).toHaveBeenCalledTimes(1);
  const undo = new KeyboardEvent('keydown', { key: 'z', metaKey: true, cancelable: true });
  document.dispatchEvent(undo); expect(undo.defaultPrevented).toBe(false);
  const input = document.createElement('input'); document.body.append(input);
  fireEvent.keyDown(input, { key: 'P', metaKey: true, shiftKey: true });
  fireEvent.keyDown(document, { key: 'P', metaKey: true, shiftKey: true, isComposing: true });
  expect(c.start).toHaveBeenCalledTimes(1); input.remove();
  act(() => requestPlaythrough('s')); expect(c.start).toHaveBeenLastCalledWith(0);
});
it('段菜单提供从这段开始连播', () => {
  render(<ShotMenu segment={{ segmentId: 1, key: 's' } as BandSegment} anchor={{ x: 0, y: 0 }} canStepBack={false} canStepForward={false} readOnly={false} onStep={() => {}} onClose={() => {}} />);
  expect(screen.getByRole('menuitem', { name: '从这段开始连播' })).toBeTruthy();
});
it('走带提供可等待 seek 与 play/pause,人工 seek 广播打断,内部 seek 不广播', async () => {
  const send = vi.fn(async () => {}); const manual = vi.fn(); window.addEventListener('tripcut:manual-seek', manual);
  const { result } = renderHook(() => useMonitorTransport({
    clip: { id: 1, fps_num: 25, fps_den: 1 } as ClipListItem,
    status: { phase: 'ready', clip_id: 1, pos: 0, duration: 20, paused: true } as PlayerStatus,
    send, inPoint: null, outPoint: null, bestStart: null, momentsLoaded: false, playthroughActive: true,
  }));
  await act(async () => { expect(await result.current.seekTo(2, { source: 'playthrough' })).toBe(true); });
  expect(manual).not.toHaveBeenCalled();
  await act(async () => { await result.current.play(); await result.current.pause(); await result.current.seekTo(3); });
  expect(send).toHaveBeenCalledWith([{ type: 'play' }]); expect(manual).toHaveBeenCalledTimes(1);
  window.removeEventListener('tripcut:manual-seek', manual);
});
it('同一连播气泡区别素材与镜头带;截图剧本有实际点击连播场景', () => {
  expect(GUIDES.autoplay.text).toContain('素材连播'); expect(GUIDES.autoplay.text).toContain('镜头带连播');
  const script = readFileSync('scripts/qa/preview-shots.mjs', 'utf8');
  expect(script).toContain('playthrough-playing');
});

it('命令面板显示镜头带连播,执行同一请求', async () => {
  const { CommandPalette } = await import('../../CommandPalette');
  const c = controller(); c.active = false;
  renderHook(() => usePlaythroughCommands(c, true));
  act(() => setPlaythroughSegments([segment]));
  render(<CommandPalette onNavigate={() => {}} onSelectClip={() => {}} />);
  fireEvent.keyDown(document, { key: 'k', metaKey: true });
  fireEvent.click(await screen.findByText('镜头带连播'));
  expect(c.start).toHaveBeenCalledWith(0);
});
