import { useEffect, useState } from "react";

import { CommandPalette } from "./CommandPalette";
import { RecoveryPage } from "./RecoveryPage";
import { applyAppearanceSettings } from "./appearance";
import { getDoctorReport, getSettings, type DoctorReport, type SettingsMap } from "./api";
import { documentTitleForRoute, routeFromHash, type RoutePath } from "./routes";
import { ExitConfirm } from "./workspace/ExitConfirm";
import { GlobalDropOverlay } from "./workspace/GlobalDropOverlay";
import { useMenuBridge } from "./workspace/menuBridge";
import { WorkspaceShell } from "./workspace/WorkspaceShell";
import { dispatchWorkspace, type BandMode } from "./workspace/WorkspaceStore";

export { documentTitleForRoute };
export type { RoutePath };

const BAND_MODES: readonly BandMode[] = ["story", "music", "journey", "destination", "template"];

function isBandMode(value: string): value is BandMode {
  return (BAND_MODES as readonly string[]).includes(value);
}

/**
 * `CommandPalette` 的 `onNavigate` 目标——命令集(§ CommandPalette.tsx)发的是
 * 面向新 IA 的动作字符串(`open-*`/`band-*`),这里只负责把它们翻译成
 * `dispatchWorkspace` 调用。
 */
function navigateWorkspace(action: string): void {
  if (action === "open-import") {
    dispatchWorkspace({ type: "open-drawer", drawer: "import" });
    return;
  }
  if (action === "open-deliver") {
    dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
    return;
  }
  if (action === "open-settings") {
    dispatchWorkspace({ type: "open-drawer", drawer: "settings" });
    return;
  }
  if (action === "open-help") {
    // 帮助浮层的开关是壳的局部 state,不在 store 里 —— 跟 `?` 走同一个事件。
    window.dispatchEvent(new CustomEvent("tripcut:open-help"));
    return;
  }
  if (action.startsWith("band-")) {
    const mode = action.slice("band-".length);
    if (isBandMode(mode)) dispatchWorkspace({ type: "set-band-mode", mode });
  }
}

/**
 * R17:旧四页壳(`ui.workspace_v2 === false`)整个删除,`WorkspaceShell` 是唯一
 * 主路径。这里只留文档标题跟着 hash 走这一件事——真正的旧 hash(`#/import`、
 * `#/deliver`、`#/settings`、`#/review`)转接到抽屉/sheet 由
 * `workspace/WorkspaceShell.tsx` 的 `drawerForLegacyHash` 自己处理。
 */
function useHashRoute(): RoutePath {
  const [route, setRoute] = useState<RoutePath>(() =>
    typeof window === "undefined" ? "/import" : routeFromHash(window.location.hash),
  );

  useEffect(() => {
    const syncRoute = () => setRoute(routeFromHash(window.location.hash));
    window.addEventListener("hashchange", syncRoute);
    if (!window.location.hash) {
      window.history.replaceState(null, "", "#/");
    }
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);

  return route;
}

export default function App() {
  const route = useHashRoute();
  // R18 M-01:原生菜单栏(`src-tauri/src/menu.rs`)的点击落到已有的那些入口。
  useMenuBridge();
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [doctorError, setDoctorError] = useState<string | undefined>();
  const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false);
  // 旗的取值在 getSettings() 落地前一律不算数(R8 终审 L4):落地前渲染一块
  // 中性骨架,不让任何"哪个壳"的线索先出现。
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    void getDoctorReport()
      .then((report) => {
        if (active) setDoctorReport(report);
      })
      .catch((error) => {
        if (active) setDoctorError(String(error));
      });
    return () => {
      active = false;
    };
  }, []);

  const workbenchReady = Boolean(
    doctorReport
      && doctorReport.status !== "FAIL"
      && !doctorReport.restart_required
      && (!doctorReport.abnormal_exit || recoveryAcknowledged),
  );

  // 同一份 getSettings 结果既喂外观又喂 store 初始化,不为了读一个键多发一次请求。
  useEffect(() => {
    if (!workbenchReady) return;
    let active = true;
    const apply = (settings: SettingsMap) => {
      applyAppearanceSettings(settings);
      if (!active) return;
      dispatchWorkspace({ type: "hydrate", settings });
      // 读失败也算"落地"——回落到前端默认值,总比一直卡在骨架上强。
      setSettingsLoaded(true);
    };
    void getSettings()
      .then(apply)
      .catch(() => apply({}));
    return () => {
      active = false;
    };
  }, [workbenchReady]);

  useEffect(() => {
    document.title = documentTitleForRoute(route);
  }, [route]);

  if (!workbenchReady) {
    return (
      <RecoveryPage
        report={doctorReport}
        loadError={doctorError}
        onReport={setDoctorReport}
        onContinue={() => setRecoveryAcknowledged(true)}
      />
    );
  }

  if (!settingsLoaded) {
    return (
      <div className="app-boot-skeleton" role="status" aria-busy="true" aria-label="正在载入工作台">
        正在准备工作台…
      </div>
    );
  }

  return (
    <>
      <WorkspaceShell />
      {/* R18 F2:关窗口时后台任务还没做完的确认(后端已经 prevent_close 了)。 */}
      <ExitConfirm />
      {/* R18 M-06①:窗口任意位置都能接素材(Dock 图标拖入走同一个入口)。 */}
      <GlobalDropOverlay />
      <CommandPalette onNavigate={navigateWorkspace} onSelectClip={(clipId) => dispatchWorkspace({ type: "select-clip", clipId })} />
    </>
  );
}
