import type { JSX } from "react";
import { ImportJobsTab } from "./import/ImportJobsTab";
import { ImportMissingTab } from "./import/ImportMissingTab";
import { ImportSourcesTab } from "./import/ImportSourcesTab";
import { useImportSources } from "./import/useImportSources";
import { useImportTabCounts, type ImportTabCounts } from "./import/useImportTabCounts";
import { Drawer } from "./ui/Drawer";
import { Tabs, type TabItem } from "./ui/Tabs";
import { dispatchWorkspace, useWorkspace, type WorkspaceState } from "./WorkspaceStore";

export type ImportDrawerTab = "source" | "jobs" | "missing";

const TABS: readonly TabItem[] = [
  { id: "source", label: "来源" },
  { id: "jobs", label: "任务" },
  { id: "missing", label: "缺失素材" },
];

/**
 * R19 U-05:分页按计数出现 —— 来源永远在;任务要导过东西(`jobs > 0`),缺失素材要真有缺失;
 * 程序直落到某个分页(状态条「缺失素材 n」、交付抽屉「去缺失素材页」)时那个分页照样在,不出现「选中了一个不存在的 tab」。
 */
export function visibleImportTabs(counts: ImportTabCounts, activeTab: ImportDrawerTab): readonly TabItem[] {
  return TABS.filter((tab) => tab.id === "source" || tab.id === activeTab || (tab.id === "jobs" ? counts.jobs > 0 : counts.missing > 0));
}

/** 素材表变了(导入 / 撤销 / 清理)——媒体池、集面板照旧靠这个事件刷新(逐字沿用 ImportPage)。 */
function notifyLibraryChanged(): void {
  window.dispatchEvent(new Event("tripcut:library-changed"));
}

/**
 * 导入抽屉(规格 §4.1):从左侧滑入,宽 min(720, 60vw),`Tabs` 三分页 来源 / 任务 / 缺失素材,
 * 内容用套件原生重写——不再包旧 ImportPage。来源 hook 挂在抽屉层:拖放覆盖层要盖住
 * 整个主体,与当前分页无关;任务 / 缺失素材各自在分页内拉数据(切走即停表)。
 */
export function ImportDrawer(): JSX.Element | null {
  const open = useWorkspace((state: WorkspaceState) => state.openDrawer === "import");
  const activeTab = useWorkspace((state: WorkspaceState) => state.importTab);

  if (!open) return null;
  return <ImportDrawerBody activeTab={activeTab} />;
}

function ImportDrawerBody({ activeTab }: { activeTab: ImportDrawerTab }): JSX.Element {
  const sources = useImportSources({ onImported: notifyLibraryChanged });
  const counts = useImportTabCounts();

  return (
    <Drawer
      open
      title="导入素材"
      side="left"
      width="min(720px, 60vw)"
      onClose={() => dispatchWorkspace({ type: "close-drawer" })}
    >
      <div className={`import-drawer${sources.dragActive ? " import-drawer--drop-target" : ""}`}>
        <Tabs
          items={visibleImportTabs(counts, activeTab)}
          value={activeTab}
          ariaLabel="导入分页"
          className="import-drawer-tabs"
          onChange={(id) => dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: id as ImportDrawerTab })}
        />
        <div className="import-drawer-scroll">
          {activeTab === "source" ? <ImportSourcesTab sources={sources} /> : null}
          {activeTab === "jobs" ? <ImportJobsTab onChanged={() => { notifyLibraryChanged(); void sources.refreshWatched(); }} /> : null}
          {activeTab === "missing" ? <ImportMissingTab /> : null}
        </div>
        {sources.dragActive ? (
          <div className="import-drawer-drop" role="status">
            <span>松开即导入</span>
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}
