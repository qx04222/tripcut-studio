/** `@tauri-apps/plugin-updater` 替身:设置 sheet 的「检查更新」在假后端下永远「已是最新」。 */
export interface Update {
  version: string;
  body?: string;
  downloadAndInstall(onEvent?: (event: unknown) => void): Promise<void>;
}

export async function check(): Promise<Update | null> {
  return null;
}
