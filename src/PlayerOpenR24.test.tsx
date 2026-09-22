// @vitest-environment jsdom
import { useCallback, useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const api = await vi.hoisted(async () => {
  const { createTestApiMock } = await import('./workspace/testApiMock');
  return createTestApiMock();
});
vi.mock('./api', () => api);
import type { ClipListItem, PlayerStatus } from './api';
import { PlayerOverlay, type EmbeddedPlayerControls } from './PlayerOverlay';
import { useMonitorTransport } from './workspace/useMonitorTransport';
import { __resetPlayerPrefsForTests } from './workspace/playerPrefs';
import { SelectSegmentsSection } from './workspace/InspectorSegments';
import { requestOpenAt, takeOpenAt } from './workspace/playthrough/store';
const clip = { id: 7, fps_num: 25, fps_den: 1, kind: 'video' } as ClipListItem;
const ready = { phase: 'ready', clip_id: 7, pos: 0, duration: 60, paused: true, error: null } as PlayerStatus;
let live: PlayerStatus;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  __resetPlayerPrefsForTests();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  live = { ...ready };
  api.listSelectSegments.mockResolvedValue([{ id: 1, clip_id: 7, in_ticks: 7400, out_ticks: 9000, tb_num: 1, tb_den: 1000 }] as never);
  api.playerSetViewport.mockResolvedValue(undefined);
  api.playerClose.mockResolvedValue(undefined);
  api.playerStatus.mockImplementation(async () => ({ ...live }));
  api.playerOpen.mockImplementation(async (clipId, paused, seconds) => {
    live = { ...ready, clip_id: clipId, pos: seconds ?? 0, paused: seconds !== undefined || Boolean(paused) };
    return { ...live };
  });
  api.playerCommand.mockImplementation(async cmd => {
    if (cmd.type === 'play') live.paused = false;
    if (cmd.type === 'pause') live.paused = true;
    if (cmd.type === 'seek_abs') live.pos = cmd.seconds;
  });
});
afterEach(() => { cleanup(); takeOpenAt(7); takeOpenAt(9); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const flush = () => act(async () => { for (let n = 0; n < 15; n++) await Promise.resolve(); });
const overlay = (onStatusChange?: (s: PlayerStatus | null) => void) =>
  <PlayerOverlay clip={clip} variant="embedded" onExit={() => {}} onStatusChange={onStatusChange} />;
const inspector = <SelectSegmentsSection clipId={7} selectCount={1} readOnly={false} />;

it('P-3 Overlay consumes the matching request and opens paused at the source in-point', async () => {
  requestOpenAt(7, 7.4);
  const observed: PlayerStatus[] = [];
  render(overlay(s => { if (s?.phase === 'ready') observed.push(s); }));
  await flush();
  expect(api.playerOpen).toHaveBeenCalledWith(7, true, 7.4);
  expect(observed[0]).toMatchObject({ pos: 7.4, paused: true });
  expect(takeOpenAt(7)).toBeNull();
  expect(api.playerCommand).not.toHaveBeenCalledWith({ type: 'play' }, 7);
});

it('P-3 ready Inspector replay still seeks then plays on the same clip', async () => {
  render(inspector); await flush();
  fireEvent.click(screen.getByRole('button', { name: '复播精选段 1' })); await flush();
  expect(api.playerCommand.mock.calls.map(([cmd]) => cmd)).toEqual([
    { type: 'seek_abs', seconds: 7.4 }, { type: 'play' },
  ]);
  expect(api.playerOpen).not.toHaveBeenCalled();
});

it.each(['loading', 'wrong-clip'] as const)('P-3 Inspector %s queues an open at in-point; Overlay resumes only after that frame', async kind => {
  live = kind === 'loading' ? { ...ready, phase: 'loading' } : { ...ready, clip_id: 9 };
  const view = render(<>{inspector}</>); await flush();
  fireEvent.click(screen.getByRole('button', { name: '复播精选段 1' })); await flush();
  expect(api.playerCommand).not.toHaveBeenCalled();
  const observed: PlayerStatus[] = [];
  view.rerender(<>{inspector}{overlay(s => { if (s?.phase === 'ready') observed.push(s); })}</>);
  await flush();
  expect(api.playerOpen).toHaveBeenCalledWith(7, true, 7.4);
  expect(observed[0]).toMatchObject({ pos: 7.4, paused: true });
  expect(api.playerCommand).toHaveBeenCalledWith({ type: 'play' }, 7);
  expect(live).toMatchObject({ pos: 7.4, paused: false });
});

it('P-3 a replay arriving during an in-flight open restarts at in-point; stale completion cannot overwrite it', async () => {
  let finishOld!: (s: PlayerStatus) => void;
  api.playerOpen.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  live = { ...ready, phase: 'loading' };
  const observed: PlayerStatus[] = [];
  render(<>{inspector}{overlay(s => { if (s?.phase === 'ready') observed.push(s); })}</>);
  await flush();
  expect(api.playerOpen).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '复播精选段 1' })); await flush();
  expect(api.playerOpen).toHaveBeenLastCalledWith(7, true, 7.4);
  await act(async () => { finishOld({ ...ready, pos: 0 }); });
  await flush();
  expect(observed.every(s => s.pos === 7.4)).toBe(true);
  expect(live.paused).toBe(false);
});

it('P-3 paused loading open waits for ready at the requested position before replaying', async () => {
  api.playerOpen.mockImplementationOnce(async () => ({ ...ready, phase: 'loading', pos: 7.4 }));
  requestOpenAt(7, 7.4, true);
  render(overlay()); await flush();
  expect(api.playerCommand).not.toHaveBeenCalled();
  live = { ...ready, pos: 7.4 };
  await act(async () => { await vi.advanceTimersByTimeAsync(80); });
  expect(api.playerCommand).toHaveBeenCalledWith({ type: 'play' }, 7);
});

function MonitorHost() {
  const [status, setStatus] = useState<PlayerStatus | null>(null);
  const controls = useRef<EmbeddedPlayerControls | null>(null);
  const send = useCallback(async (commands: Parameters<EmbeddedPlayerControls['send']>[0]) => {
    await controls.current?.send(commands);
  }, []);
  useMonitorTransport({ clip, status, send, inPoint: null, outPoint: null,
    bestStart: 2, momentsLoaded: true, openAt: controls.current?.openAt });
  return <PlayerOverlay clip={clip} variant="embedded" controlsRef={controls} onStatusChange={setStatus} onExit={() => {}} />;
}
it('P-3 Inspector replay wins over the real monitor initial preview preparation', async () => {
  requestOpenAt(7, 7.4, true);
  render(<MonitorHost />); await flush(); await flush();
  expect(live).toMatchObject({ pos: 7.4, paused: false });
  expect(api.playerCommand.mock.calls.filter(([cmd]) => cmd.type === 'seek_abs')).toEqual([]);
});

it('P-3 a cancelled viewport setup cannot steal the replacement open request', async () => {
  let finishViewport!: () => void;
  api.playerSetViewport.mockImplementationOnce(() => new Promise(resolve => { finishViewport = resolve; }));
  // Ensure a nonzero surface so viewport setup is awaited.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 600, height: 400, right: 600, bottom: 400 } as DOMRect);
  render(overlay()); await flush();
  await act(async () => { requestOpenAt(7, 7.4); }); await flush();
  await act(async () => { finishViewport(); }); await flush();
  expect(api.playerOpen).toHaveBeenCalledTimes(1);
  expect(api.playerOpen).toHaveBeenCalledWith(7, true, 7.4);
  vi.restoreAllMocks();
});
it('P-3 switching away discards an unconsumed Inspector replay request', async () => {
  live = { ...ready, phase: 'loading' };
  const view = render(inspector); await flush();
  fireEvent.click(screen.getByRole('button', { name: '复播精选段 1' })); await flush();
  view.rerender(<SelectSegmentsSection clipId={9} selectCount={0} readOnly={false} />); await flush();
  expect(takeOpenAt(7)).toBeNull();
});
