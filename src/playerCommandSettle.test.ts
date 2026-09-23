import { expect, it, vi } from 'vitest';
import type { PlayerCommand } from './api';
import { STALE_CLIP_COMMAND } from './api';
import { COMMAND_SETTLE_ATTEMPTS, PLAYER_COMMAND_TIMEOUT_TEXT, isPlayerCommandTimeout, sendPlayerCommandSettled } from './playerCommandSettle';

it.each([{ type: 'pause' }, { type: 'step_fwd' }, { type: 'apply_display_lut', path: '/tmp/look.cube' }] as PlayerCommand[])('超时后 sync 成功,不重发原命令: %j', async command => {
  const send = vi.fn< (cmd: PlayerCommand, owner?: number) => Promise<void> >()
    .mockRejectedValueOnce(PLAYER_COMMAND_TIMEOUT_TEXT).mockResolvedValue(undefined);
  await expect(sendPlayerCommandSettled(command, 9, send)).resolves.toBeUndefined();
  expect(send.mock.calls).toEqual([[command, 9], [{ type: 'sync' }, 9]]);
});
it('栅栏连续超时四次才抛最初的错误', async () => {
  const original = new Error(PLAYER_COMMAND_TIMEOUT_TEXT);
  const send = vi.fn().mockRejectedValue(PLAYER_COMMAND_TIMEOUT_TEXT).mockRejectedValueOnce(original);
  await expect(sendPlayerCommandSettled({ type: 'pause' }, undefined, send)).rejects.toBe(original);
  expect(COMMAND_SETTLE_ATTEMPTS).toBe(4);
  expect(send.mock.calls).toEqual([[{ type: 'pause' }, undefined], ...Array.from({ length: 4 }, () => [{ type: 'sync' }, undefined])]);
});
it.each([new Error('播放器尚未打开'), STALE_CLIP_COMMAND])('非超时原样抛出,不发栅栏: %s', async reason => {
  const send = vi.fn().mockRejectedValue(reason);
  await expect(sendPlayerCommandSettled({ type: 'pause' }, 9, send)).rejects.toBe(reason);
  expect(send).toHaveBeenCalledTimes(1);
});
it.each([new Error('播放器尚未打开'), STALE_CLIP_COMMAND])('栅栏收到非超时也原样抛出: %s', async reason => {
  const send = vi.fn().mockRejectedValueOnce(PLAYER_COMMAND_TIMEOUT_TEXT).mockRejectedValue(reason);
  await expect(sendPlayerCommandSettled({ type: 'pause' }, 9, send)).rejects.toBe(reason);
  expect(send).toHaveBeenCalledTimes(2);
});
it('只识别逐字一致的 string / Error 超时,正常命令不加栅栏', async () => {
  expect(isPlayerCommandTimeout(PLAYER_COMMAND_TIMEOUT_TEXT)).toBe(true);
  expect(isPlayerCommandTimeout(new Error(PLAYER_COMMAND_TIMEOUT_TEXT))).toBe(true);
  for (const value of [null, undefined, 2, {}, '其它错误: 播放器命令响应超时']) expect(isPlayerCommandTimeout(value)).toBe(false);
  const send = vi.fn().mockResolvedValue(undefined);
  await sendPlayerCommandSettled({ type: 'pause' }, 9, send);
  expect(send.mock.calls).toEqual([[{ type: 'pause' }, 9]]);
});
