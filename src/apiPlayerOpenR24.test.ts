import { expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue({}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { playerOpen } from './api';
it('P-3 playerOpen preserves legacy argument objects, adds source start only when supplied', async () => {
  await playerOpen(7);
  expect(invoke).toHaveBeenLastCalledWith('player_open', { clipId: 7, startPaused: false });
  await playerOpen(7, true);
  expect(invoke).toHaveBeenLastCalledWith('player_open', { clipId: 7, startPaused: true });
  await playerOpen(7, false, 7.4);
  expect(invoke).toHaveBeenLastCalledWith('player_open', { clipId: 7, startPaused: false, startSeconds: 7.4 });
});
