import { Suspense, lazy, useEffect, useState } from "react";

import { CommandPalette } from "./CommandPalette";
import { FirstRunGuide } from "./FirstRunGuide";
import { RecoveryPage } from "./RecoveryPage";
import { applyAppearanceSettings } from "./appearance";
import { getDoctorReport, getSettings, type DoctorReport, type SettingsMap } from "./api";
import { NAVIGATION, documentTitleForRoute, routeFromHash, type RoutePath } from "./routes";
import { WorkspaceShell } from "./workspace/WorkspaceShell";
import { dispatchWorkspace, type BandMode } from "./workspace/WorkspaceStore";
import { WORKSPACE_FLAG_KEY, readUiBool } from "./workspace/uiSettings";

export { NAVIGATION, documentTitleForRoute };
export type { RoutePath };

/**
 * 旧四页壳整体懒加载。此前 App.tsx 静态 import 了 ImportPage/DeliverPage/
 * SettingsPage 给旧壳用,rolldown 于是把 `WorkspaceShell` 里那三个 `lazy()` 的
 * 目标一起提升进首屏 chunk——产物里一条 dynamic import 都没有(R8 终审 M1)。
 * 现在旧壳自己也是一个 `lazy()` 目标,两个壳各自成块;**不要**从本文件静态
 * 引用 `./LegacyShell` 里的任何符号。
 */
const LazyLegacyShell = lazy(() =>
  import("./LegacyShell").then((module) => ({ default: module.AppShell })),
);

const BAND_MODES: readonly BandMode[] = ["story", "music", "journey", "destination", "template"];

function isBandMode(value: string): value is BandMode {
  return (BAND_MODES as readonly string[]).includes(value);
}

/**
 * 新壳下 `CommandPalette` 的 `onNavigate` 目标——命令集本身(§ CommandPalette.tsx)
 * 已经是面向新 IA 的动作字符串(`open-*`/`band-*`),这里只负责把它们翻译成
 * `dispatchWorkspace` 调用,不复用旧壳按 hash 路由的 `onNavigate`。
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

function useHashRoute(): RoutePath {
  const [route, setRoute] = useState<RoutePath>(() =>
    typeof window === "undefined" ? "/import" : routeFromHash(window.location.hash),
  );

  useEffect(() => {
    const syncRoute = () => setRoute(routeFromHash(window.location.hash));
    window.addEventListener("hashchange", syncRoute);
    // 空 hash 落到 `#/`:新壳把它当工作区本体(不弹任何抽屉);旧壳的 routeFromHash
    // 对未知路径本就回落到 /import,两边都不需要 `#/import` 这个会弹导入抽屉的默认值。
    if (!window.location.hash) {
      window.history.replaceState(null, "", "#/");
    }
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);

  return route;
}

export default function App() {
  const route = useHashRoute();
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [doctorError, setDoctorError] = useState<string | undefined>();
  const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false);
  const [workspaceV2, setWorkspaceV2] = useState(true);
  // 旗的取值在 getSettings() 落地前一律不算数(R8 终审 L4):此前默认 true 会先渲染
  // 一帧新壳,旗其实是 false 的用户于是每次启动都看见新壳闪一下再被换掉。落地前
  // 渲染一块中性骨架——两个壳的专属元素一个都不出现。
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  useEffect(() => {
    // 设置 sheet 里的界面开关写完 ui.workspace_v2 后广播这个事件,让旗状态当场
    // 更新——不这样做就得等下次重启才生效,不满足"不要求重启"。
    const onFlagChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceV2: boolean }>).detail;
      setWorkspaceV2(detail.workspaceV2);
    };
    window.addEventListener("tripcut:workspace-flag-changed", onFlagChanged);
    return () => window.removeEventListener("tripcut:workspace-flag-changed", onFlagChanged);
  }, []);

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

  // 同一份 getSettings 结果既喂外观又判旗,不为了读一个键多发一次请求。
  useEffect(() => {
    if (!workbenchReady) return;
    let active = true;
    const apply = (settings: SettingsMap) => {
      applyAppearanceSettings(settings);
      if (!active) return;
      setWorkspaceV2(readUiBool(settings, WORKSPACE_FLAG_KEY));
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
    // 中性骨架:没有顶栏、没有四步导航、没有媒体池——任何"哪个壳"的线索都不给。
    return <div className="app-boot-skeleton" role="status" aria-busy="true" aria-label="正在载入工作台" />;
  }

  // 旗默认开(ui.workspace_v2 不在 Rust defaults() 里,没写过就是前端默认值 "true",
  // 见 UI_SETTING_DEFAULTS)。设置 sheet 的界面开关写回显式 "false" 才落到旧四页壳。
  if (workspaceV2) {
    return (
      <>
        <WorkspaceShell />
        <CommandPalette onNavigate={navigateWorkspace} onSelectClip={(clipId) => dispatchWorkspace({ type: "select-clip", clipId })} />
        <FirstRunGuide />
      </>
    );
  }
  return (
    <Suspense fallback={<div className="app-boot-skeleton" role="status" aria-busy="true" aria-label="正在载入工作台" />}>
      <LazyLegacyShell route={route} />
      <FirstRunGuide />
    </Suspense>
  );
}
