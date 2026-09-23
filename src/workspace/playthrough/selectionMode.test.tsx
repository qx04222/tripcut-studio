// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestApiMock } from '../testApiMock';
vi.mock('../../api', async () => createTestApiMock());
import type { PlayerStatus } from '../../api';
import { PlaythroughButton, PlaythroughOverlay, PlaythroughStatus } from './PlaythroughOverlay';
import { publishPlaythrough, setPlaythroughSegments, usePlaythroughCommands } from './store';
import { usePlaythrough, type PlaythroughController } from './usePlaythrough';
import { Scrubber } from '../scrubber/Scrubber';

const segments = [
  { key: 'a', clipId: 1, inPoint: 2, outPoint: 8, fps: 25, chapter: '1' },
  { key: 'b', clipId: 1, inPoint: 12, outPoint: 18, fps: 25, chapter: '2' },
];
const status = { phase: 'ready', clip_id: 1, pos: 12, duration: 30, paused: true } as PlayerStatus;
afterEach(() => { cleanup(); publishPlaythrough(null); setPlaythroughSegments([]); });

it.each([
  ['selection', 1, 0, '选段 · 章 2', '选段 · 00:02 / 00:06', '选段'],
  ['selection', 2, 1, '选段 · 第 2/2 段 · 章 2', '选段 2/2 · 00:02 / 00:06', '选段 第 2/2 段'],
  ['band', 2, 1, '连播 · 第 2/2 段 · 章 2', '连播 2/2 · 00:02 / 00:06', '连播 第 2/2 段'],
] as const)('%s %i 段:文案与 AX', (mode, total, index, heading, line, valueText) => {
  const c = { mode, active: true, phase: 'playing', total, index, segment: segments[1], elapsed: 2, duration: 6,
    loop: false, switchMs: null, next: vi.fn(), previous: vi.fn(), stop: vi.fn(), toggleLoop: vi.fn() } as unknown as PlaythroughController;
  publishPlaythrough(c); setPlaythroughSegments(segments);
  render(<><PlaythroughButton /><PlaythroughStatus /><PlaythroughOverlay controller={c} /></>);
  expect(screen.getByText(heading)).toBeTruthy();
  expect(screen.getByText(line)).toBeTruthy();
  expect(screen.getByRole('progressbar', { name: '镜头带总进度' }).getAttribute('aria-valuetext')).toBe(valueText);
  const stop = screen.getByRole('group', { name: '镜头带连播预览' }).querySelector('[aria-label="停止连播"]');
  expect(stop?.getAttribute('title')).toBe(mode === 'selection' ? '结束选段' : null);
  if (mode === 'selection') expect(screen.getByRole('button', { name: '镜头带连播' }).textContent).toBe('连播');
  else expect(screen.getAllByRole('button', { name: '停止连播' })).toHaveLength(2);
});

it('真实 selection 会话点连播从整带第 0 段开始;再次点击才停止', async () => {
  const transport = { pause: vi.fn(async () => {}), play: vi.fn(async () => {}), seekTo: vi.fn(async () => true), setEnd: vi.fn(async () => {}) };
  setPlaythroughSegments(segments);
  const { result } = renderHook(() => {
    const c = usePlaythrough({ segments, selectedClipId: 1, status, enabled: true, transport, selectClip: vi.fn() });
    usePlaythroughCommands(c, true);
    useEffect(() => publishPlaythrough(c), [c]);
    return c;
  });
  render(<PlaythroughButton />);
  expect(result.current.mode).toBe('band');
  await act(async () => result.current.select(segments[1]!, 12, true));
  expect(result.current.mode).toBe('selection');
  expect(result.current.index).toBe(1);
  expect(result.current.active).toBe(true);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '镜头带连播' })));
  expect(result.current.mode).toBe('band');
  expect(result.current.active).toBe(true);
  expect(result.current.index).toBe(0);
  expect(result.current.total).toBe(2);
  expect(transport.seekTo).toHaveBeenLastCalledWith(2, { source: 'playthrough' });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '停止连播' })));
  expect(result.current.active).toBe(false);
});

it('Scrubber 收到 mode 后只调整当前段 title', () => {
  const range = { inPoint: 12, outPoint: 18, index: 1, total: 2 };
  const view = render(<Scrubber status={status} fps={25} inPoint={null} outPoint={null} onSeek={vi.fn()}
    playthrough={{ ...range, mode: 'selection' }} />);
  expect(screen.getByTitle('选段:当前段').textContent).toBe('第 2/2 段');
  view.rerender(<Scrubber status={status} fps={25} inPoint={null} outPoint={null} onSeek={vi.fn()}
    playthrough={{ ...range, mode: 'band' }} />);
  expect(screen.getByTitle('镜头带连播:当前段')).toBeTruthy();
});
