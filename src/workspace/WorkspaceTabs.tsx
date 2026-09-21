import { useEffect, type JSX } from "react";
import { Tabs } from "./ui";
import { dispatchWorkspace, useWorkspace, type WorkspaceMode } from "./WorkspaceStore";

const ITEMS = [
  { id: "video", label: "视频工作台" },
  { id: "photo", label: "照片工作台" },
] as const;

export function WorkspaceTabs(): JSX.Element {
  const mode = useWorkspace((state) => state.workspaceMode);
  const choose = (next: string) => dispatchWorkspace({ type: "set-workspace-mode", mode: next as WorkspaceMode });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey || !event.shiftKey || event.altKey || event.ctrlKey) return;
      const next = event.code === "Digit1" ? "video" : event.code === "Digit2" ? "photo" : null;
      if (next === null) return;
      event.preventDefault();
      choose(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return <Tabs items={ITEMS} value={mode} onChange={choose} ariaLabel="工作台" className="workspace-mode-tabs" />;
}
