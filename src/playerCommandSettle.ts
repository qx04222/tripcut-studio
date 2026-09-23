import { playerCommand, type PlayerCommand } from './api';

export const PLAYER_COMMAND_TIMEOUT_TEXT = '播放器命令响应超时'; // 与 Rust command_for 逐字一致。
export const COMMAND_SETTLE_ATTEMPTS = 4; // 每次 Rust 侧最多等 2 s。

export function isPlayerCommandTimeout(reason: unknown): boolean {
  return (reason instanceof Error ? reason.message : reason) === PLAYER_COMMAND_TIMEOUT_TEXT;
}

/** 超时的命令仍在渲染队列里:只追加 sync 等待终态,绝不重发 step / vf add 等非幂等命令。
 * 栅栏也超时最多再等四次;其它错误(含换素材拒绝)原样抛出。 */
export async function sendPlayerCommandSettled(
  command: PlayerCommand,
  owner: number | undefined,
  send: (command: PlayerCommand, owner?: number) => Promise<void> = playerCommand,
): Promise<void> {
  try {
    await send(command, owner);
  } catch (original) {
    if (!isPlayerCommandTimeout(original)) throw original;
    for (let attempt = 0; attempt < COMMAND_SETTLE_ATTEMPTS; attempt++) {
      try {
        await send({ type: 'sync' }, owner);
        return;
      } catch (reason) {
        if (!isPlayerCommandTimeout(reason)) throw reason;
      }
    }
    throw original;
  }
}
