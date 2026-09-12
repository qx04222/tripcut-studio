/** `@tauri-apps/api/webview` 替身:导入页只用 `getCurrentWebview().onDragDropEvent`。 */
export function getCurrentWebview(): {
  onDragDropEvent(handler: (event: unknown) => void): Promise<() => void>;
} {
  return {
    async onDragDropEvent() {
      return () => undefined;
    },
  };
}
