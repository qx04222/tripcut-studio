/** `@tauri-apps/plugin-process` 替身:假后端里没有进程可重启。 */
export async function relaunch(): Promise<void> {
  throw new Error("mock backend: relaunch is not available in preview mode");
}
