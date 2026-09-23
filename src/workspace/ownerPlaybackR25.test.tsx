// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestApiMock } from './testApiMock';
vi.mock('../api', async () => createTestApiMock());
import { getSettings, setSetting, type ClipListItem, type PlayerCommand, type PlayerStatus } from '../api';
import { __resetPlayerPrefsForTests, loadPlayerPrefs } from './playerPrefs';
import { useMonitorTransport, type MonitorTransportDeps } from './useMonitorTransport';
import { Scrubber } from './scrubber/Scrubber';
import { suggestionRanges, suggestionStatusLine } from './monitorSuggestions';
import { usePlaythrough, type PlaythroughDeps } from './playthrough/usePlaythrough';
const status = (pos = 0, clip_id = 1, paused = false) => ({ phase: 'ready', clip_id, pos, paused, duration: 200 } as PlayerStatus);
beforeEach(() => { __resetPlayerPrefsForTests(); vi.clearAllMocks(); vi.mocked(getSettings).mockResolvedValue({}); });
afterEach(cleanup);
it('002: ten different long/short clips with/without suggestions stay playing at zero without pause/seek/fence', () => {
  const send = vi.fn(async () => {});
  const deps = (id: number): MonitorTransportDeps => ({ clip: { id } as ClipListItem, status: { ...status(0, id), duration: id % 2 ? 200 : 8 }, send, inPoint: 3, outPoint: 6, bestStart: id % 2 ? 41 : null, momentsLoaded: true });
  const h = renderHook(useMonitorTransport, { initialProps: deps(1) });
  for (let id = 2; id <= 10; id++) h.rerender(deps(id));
  expect(send.mock.calls.flat()).toEqual([]);
});
it('004/006: default full, suggestion changes retain full; zoom persists through settings and remount', async () => {
  const props = { status: status(5), inPoint: 2, outPoint: 10, onSeek: vi.fn() };
  const v = render(<Scrubber {...props} />);
  const scope = screen.getByRole('button', { name: '切换进度条范围' });
  expect(scope.textContent).toContain('完整素材');
  expect(document.querySelector<HTMLElement>('.monitor-seek-range')!.style.left).toBe('1%');
  expect(document.querySelector<HTMLElement>('.monitor-seek-range')!.style.width).toMatch(/^calc\((5% - 1%|4%)\)$/);
  v.rerender(<Scrubber {...props} inPoint={20} outPoint={30} />);
  expect(scope.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(scope);
  expect(setSetting).toHaveBeenCalledWith('ui.player.scrubber_view', 'zoom');
  v.unmount();
  act(() => __resetPlayerPrefsForTests());
  vi.mocked(getSettings).mockResolvedValue({ 'ui.player.scrubber_view': 'zoom' });
  await act(async () => loadPlayerPrefs());
  const remounted = render(<Scrubber {...props} />);
  expect(screen.getByRole('button', { name: '切换进度条范围' }).getAttribute('aria-pressed')).toBe('true');
  remounted.rerender(<Scrubber {...props} status={status(5, 2)} />);
  expect(screen.getByRole('button', { name: '切换进度条范围' }).getAttribute('aria-pressed')).toBe('true');
  expect(props.onSeek).not.toHaveBeenCalled();
});
it.each([30, 50, 60])('004/006: %i fps zoom overflow follows true position; playthrough respects full view', async fps => {
  const props = { status: status(63), inPoint: 63, outPoint: 71, fps, onSeek: vi.fn() };
  const v = render(<Scrubber {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '切换进度条范围' }));
  v.rerender(<Scrubber {...props} status={status(83.3)} />);
  expect(Number.parseFloat(document.querySelector<HTMLElement>('.scrubber-r22-head')!.style.left)).toBeCloseTo(41.65);
  expect(screen.getByRole('slider', { name: '播放位置' }).getAttribute('aria-valuenow')).toBe('83.3');
  fireEvent.click(screen.getByRole('button', { name: '切换进度条范围' }));
  v.rerender(<Scrubber {...props} playthrough={{ inPoint: 20, outPoint: 30, index: 1, total: 3 }} />);
  expect(document.querySelector<HTMLElement>('[data-playing]')!.style.left).toBe('10%');
  expect(screen.getByRole('button', { name: '切换进度条范围' })).not.toHaveProperty('disabled', true);
});
it.each([10, 1000])('005: chronological navigation/numbering preserves score and data (duration scale %i)', scale => {
  const items = [ { in_ticks: 7*scale, out_ticks: 8*scale, score: .9, reasons: [] }, { in_ticks: scale, out_ticks: 2*scale, score: .3, reasons: [] }, { in_ticks: 2*scale, out_ticks: 3*scale, score: .8, reasons: [] } ];
  const original = JSON.stringify(items);
  const ranges = suggestionRanges(items, { tb_num: 1, tb_den: scale });
  expect(ranges.map(r => r.inSeconds)).toEqual([1, 2, 7]);
  expect(ranges.map(r => r.score)).toEqual([.3, .8, .9]);
  ranges.forEach((_, i) => expect(suggestionStatusLine(i, ranges)).toContain(`建议 ${i+1}/3`));
  expect(JSON.stringify(items)).toBe(original);
});
it('001: autoAdvance off still awaits SetEnd before Play and stops without next seek/open', async () => {
  const transport = { pause: vi.fn(async () => {}), play: vi.fn(async () => {}), seekTo: vi.fn(async () => true), setEnd: vi.fn(async (_end: number | null) => {}) };
  const segments = [{ key: 'a', clipId: 1, inPoint: 138.5, outPoint: 146.5, fps: 50, chapter: '1' }, { key: 'b', clipId: 2, inPoint: 2, outPoint: 5, fps: 50, chapter: '2' }];
  let props = { segments, selectedClipId: 1, status: status(), enabled: true, autoAdvance: false, transport, selectClip: vi.fn() };
  const h = renderHook((p: PlaythroughDeps) => usePlaythrough(p), { initialProps: props });
  // R25 真机修正:单选一个镜头(select)才受监视器「连播」开关管;「镜头带连播」(start)见下一条。
  await act(async () => h.result.current.select(segments[0]!, 138.5, true));
  let finish!: () => void;
  transport.setEnd.mockImplementationOnce(() => new Promise<void>(r => { finish = r; }));
  props = { ...props, status: status(138.5, 1, true) };
  await act(async () => h.rerender(props));
  expect(transport.play).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(transport.play).toHaveBeenCalledTimes(1);
  transport.seekTo.mockClear(); props.selectClip.mockClear();
  props = { ...props, status: status(146.48, 1, true) };
  await act(async () => h.rerender(props));
  expect(h.result.current.phase).toBe('done');
  expect(props.selectClip).not.toHaveBeenCalled();
  expect(transport.seekTo).not.toHaveBeenCalledWith(2, expect.anything());
});

it('001: explicit 镜头带连播 (start) advances to the next shot even with the monitor 连播 toggle off', async () => {
  const transport = { pause: vi.fn(async () => {}), play: vi.fn(async () => {}), seekTo: vi.fn(async () => true), setEnd: vi.fn(async (_end: number | null) => {}) };
  const segments = [{ key: 'a', clipId: 1, inPoint: 138.5, outPoint: 146.5, fps: 50, chapter: '1' }, { key: 'b', clipId: 2, inPoint: 2, outPoint: 5, fps: 50, chapter: '2' }];
  let props = { segments, selectedClipId: 1, status: status(), enabled: true, autoAdvance: false, transport, selectClip: vi.fn() };
  const h = renderHook((p: PlaythroughDeps) => usePlaythrough(p), { initialProps: props });
  await act(async () => h.result.current.start());
  props = { ...props, status: status(138.5, 1, true) };
  await act(async () => h.rerender(props));
  expect(transport.play).toHaveBeenCalledTimes(1);
  props = { ...props, status: status(146.48, 1, true) };
  await act(async () => h.rerender(props));
  await act(async () => {});
  expect(h.result.current.phase).not.toBe('done');
  expect(props.selectClip).toHaveBeenCalledWith(2);
});

it('002: late moments and stale A/B statuses never pause, play or seek the final clip', () => {
  const send = vi.fn(async () => {});
  const initial = { clip: { id: 1 } as ClipListItem, status: status(), send, inPoint: 20, outPoint: 30, momentsLoaded: false, bestStart: null as number | null };
  const h = renderHook(useMonitorTransport, { initialProps: initial });
  h.rerender({ ...initial, clip: { id: 2 } as ClipListItem });
  h.rerender({ ...initial, clip: { id: 3 } as ClipListItem, status: status(80, 2) });
  h.rerender({ ...initial, clip: { id: 3 } as ClipListItem, status: status(0, 3) });
  h.rerender({ ...initial, clip: { id: 3 } as ClipListItem, status: status(0, 3), momentsLoaded: true, bestStart: 41 });
  expect(send).not.toHaveBeenCalled();
});

it('005: suggestion hook navigation and labels use time/end/score order without changing stored candidates', async () => {
  const api = await import('../api');
  const { useClipSuggestions } = await import('./useClipSuggestions');
  const items = [
    { in_ticks: 20, out_ticks: 30, score: .9, reasons: ['late'] },
    { in_ticks: 1, out_ticks: 4, score: .4, reasons: ['long'] },
    { in_ticks: 1, out_ticks: 3, score: .2, reasons: ['low'] },
    { in_ticks: 1, out_ticks: 3, score: .8, reasons: ['high'] },
  ];
  vi.mocked(api.suggestSegments).mockResolvedValue(items);
  vi.mocked(api.getClipMoments).mockResolvedValue([]);
  const original = JSON.stringify(items);
  const h = renderHook(() => useClipSuggestions({ id: 1, tb_num: 1, tb_den: 1 } as ClipListItem, 60));
  await act(async () => {});
  expect(h.result.current.current).toMatchObject({ inSeconds: 1, outSeconds: 3, score: .8 });
  expect(h.result.current.statusLine).toContain('建议 1/4');
  await act(async () => { h.result.current.step(1); });
  expect(h.result.current.current?.score).toBe(.2);
  expect(h.result.current.statusLine).toContain('建议 2/4');
  await act(async () => { h.result.current.step(1); });
  expect(h.result.current.current?.outSeconds).toBe(4);
  await act(async () => { h.result.current.step(1); });
  expect(h.result.current.current?.inSeconds).toBe(20);
  await act(async () => { h.result.current.step(-1); });
  expect(h.result.current.statusLine).toContain('建议 3/4');
  expect(JSON.stringify(items)).toBe(original);
  expect(setSetting).not.toHaveBeenCalled();
});

it('002: late mute preference is restored without interrupting zero autoplay', async () => {
  const { notifyPlayerPref } = await import('./playerPrefs');
  const send = vi.fn(async (_commands: PlayerCommand[]) => {});
  renderHook(() => useMonitorTransport({ clip: { id: 1 } as ClipListItem, status: status(), send, inPoint: null, outPoint: null }));
  await act(async () => notifyPlayerPref('ui.player.muted', true));
  expect(send).toHaveBeenCalledWith([{ type: 'set_mute', muted: true }]);
  expect(send.mock.calls.flat(2).filter(c => c.type === 'pause' || c.type === 'seek_abs')).toEqual([]);
});
