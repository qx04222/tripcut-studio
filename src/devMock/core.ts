/**
 * `@tauri-apps/api/core` 的替身 —— 只在 `vite --mode mock` 下由 alias 接进来
 * (`vite.config.ts`)。`src/api.ts` 一行不改:它照旧 `import { invoke }`,拿到的是
 * 这里这个,每条命令分派到 `fixture.ts` 的处理表;没登记的命令**必须抛**,而且
 * 抛出的信息里带命令名,漏一条就在浏览器控制台/截图装置里当场看见。
 */
import { handleMockCommand } from "./fixture";

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // 真 Tauri 的 invoke 是跨进程的,永远异步;这里也强制让出一次微任务,免得
  // 组件里「先 await 再 setState」的顺序假设在假后端下被同步返回打乱。
  await Promise.resolve();
  return handleMockCommand(cmd, args ?? {}) as T;
}

/** `convertFileSrc` 在本仓库没被用到;留一个同签名的直通版以防将来有人 import。 */
export function convertFileSrc(filePath: string, protocol = "asset"): string {
  return `${protocol}://localhost/${encodeURIComponent(filePath)}`;
}
