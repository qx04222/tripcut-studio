import { useEffect, useState, type ReactNode } from "react";

import { DeliverPage } from "./DeliverPage";
import { FirstRunGuide } from "./FirstRunGuide";
import { ImportPage } from "./ImportPage";
import { CommandPalette } from "./CommandPalette";
import { EpisodePanel } from "./EpisodePanel";
import { SetupWizard } from "./SetupWizard";
import { SidebarSearch } from "./SidebarSearch";
import { RecoveryPage } from "./RecoveryPage";
import { SelectPage } from "./SelectPage";
import { SettingsPage, applyAppearanceSettings } from "./SettingsPage";
import { getDoctorReport, getSettings, type DoctorReport } from "./api";

export type RoutePath = "/import" | "/review" | "/deliver" | "/settings";

interface NavigationItem {
  path: RoutePath;
  step: string;
  label: string;
  eyebrow: string;
}

export const NAVIGATION: readonly NavigationItem[] = [
  { path: "/import", step: "01", label: "导入", eyebrow: "INGEST" },
  { path: "/review", step: "02", label: "筛片", eyebrow: "SELECT" },
  { path: "/deliver", step: "03", label: "交付", eyebrow: "DELIVER" },
  { path: "/settings", step: "04", label: "设置", eyebrow: "SETTINGS" },
] as const;

const PAGE_CONTENT: Record<
  RoutePath,
  { kicker: string; title: string; description: string; emptyTitle: string; emptyBody: string }
> = {
  "/import": {
    kicker: "素材入口",
    title: "把旅途带进来",
    description: "连接相机卡、移动硬盘或本地文件夹，建立只读素材索引。",
    emptyTitle: "等待第一批素材",
    emptyBody: "导入与校验能力将在后续任务卡接入；当前页面仅提供工作流占位。",
  },
  "/review": {
    kicker: "故事选择",
    title: "留下真正值得看的",
    description: "按场景浏览、评级与标记，把冗长素材收束为清晰故事。",
    emptyTitle: "筛片台尚未装载",
    emptyBody: "播放器与评级交互将在后续任务卡接入；缩略图与波形已可在导入页检查。",
  },
  "/deliver": {
    kicker: "成片出口",
    title: "把选择交付出去",
    description: "从已确认的片段生成清单、稳定包或后续剪辑工程。",
    emptyTitle: "还没有可交付项目",
    emptyBody: "导出与剪映工程将在后续任务卡实现；这里保留完整工作流终点。",
  },
  "/settings": {
    kicker: "工作台控制",
    title: "把工具调到顺手",
    description: "统一管理外观、性能、分析工具与本地缓存，设置保存在这台 Mac 上。",
    emptyTitle: "设置尚未载入",
    emptyBody: "本地设置读取失败时仍会使用安全默认值。",
  },
};

export function documentTitleForRoute(route: RoutePath): string {
  const labels: Record<RoutePath, string> = {
    "/import": "导入素材",
    "/review": "筛片工作台",
    "/deliver": "交付",
    "/settings": "设置与帮助",
  };
  return `${labels[route]} · 旅剪`;
}

function routeFromHash(hash: string): RoutePath {
  const candidate = hash.replace(/^#/, "");
  return NAVIGATION.some((item) => item.path === candidate)
    ? (candidate as RoutePath)
    : "/import";
}

function useHashRoute(): RoutePath {
  const [route, setRoute] = useState<RoutePath>(() =>
    typeof window === "undefined" ? "/import" : routeFromHash(window.location.hash),
  );

  useEffect(() => {
    const syncRoute = () => setRoute(routeFromHash(window.location.hash));
    window.addEventListener("hashchange", syncRoute);
    if (!window.location.hash) {
      window.history.replaceState(null, "", "#/import");
    }
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);

  return route;
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="frame-corners" aria-hidden="true" />
      {children}
    </div>
  );
}

export function AppShell({ route }: { route: RoutePath }) {
  const [deliverAvailable, setDeliverAvailable] = useState(false);
  useEffect(() => {
    if (route !== "/deliver") {
      setDeliverAvailable(false);
      return;
    }
    const onAvailability = (event: Event) => {
      setDeliverAvailable(Boolean((event as CustomEvent<boolean>).detail));
    };
    window.addEventListener("tripcut:deliver-availability", onAvailability);
    return () => window.removeEventListener("tripcut:deliver-availability", onAvailability);
  }, [route]);

  const [wizardOpen, setWizardOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("tripcut.wizard.done") !== "1"; } catch { return true; }
  });
  const closeWizard = () => {
    try { localStorage.setItem("tripcut.wizard.done", "1"); } catch { /* per-viewer convenience */ }
    setWizardOpen(false);
  };
  useEffect(() => {
    const onOpen = () => setWizardOpen(true);
    window.addEventListener("tripcut:open-wizard", onOpen);
    return () => window.removeEventListener("tripcut:open-wizard", onOpen);
  }, []);

  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("tripcut.sidebar.collapsed") === "1"; } catch { return false; }
  });
  const toggleSidebar = () => {
    setSidebarCollapsed((value) => {
      const next = !value;
      try { localStorage.setItem("tripcut.sidebar.collapsed", next ? "1" : "0"); } catch { /* per-viewer convenience only */ }
      return next;
    });
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "\\" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggleSidebar();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const content = PAGE_CONTENT[route];

  return (
    <div className="app-shell">
      <aside className={`sidebar${sidebarCollapsed ? " collapsed" : ""}`}>
        <button
          type="button"
          className="sidebar-toggle"
          title="收起/展开侧栏(⌘\\)"
          aria-label="收起或展开侧栏"
          onClick={toggleSidebar}
        >
          {sidebarCollapsed ? "»" : "«"}
        </button>
        <a className="brand" href="#/import" aria-label="旅剪工作台首页">
          <BrandMark />
          <span>
            <strong>旅剪</strong>
            <small>TRIPCUT STUDIO</small>
          </span>
        </a>

        {sidebarCollapsed ? null : (
          <>
            <SidebarSearch
              onSelectClip={(clipId) => {
                window.location.hash = "/review";
                window.setTimeout(() => {
                  window.dispatchEvent(new CustomEvent("tripcut:select-clip", { detail: clipId }));
                }, 120);
              }}
            />
            <EpisodePanel />
          </>
        )}

        <nav className="workflow-nav" aria-label="工作流导航">
          {NAVIGATION.map((item) => {
            const active = item.path === route;
            return (
              <a
                className={active ? "nav-item active" : "nav-item"}
                href={`#${item.path}`}
                aria-current={active ? "page" : undefined}
                key={item.path}
              >
                <span className="nav-step">{item.step}</span>
                <span className="nav-copy">
                  <strong>{item.label}</strong>
                  <small>{item.eyebrow}</small>
                </span>
                <span className="nav-arrow" aria-hidden="true">
                  ↗
                </span>
              </a>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <span className="status-dot" aria-hidden="true" />
          <span>
            <strong>本地项目</strong>
            <small>LOCAL SQLITE</small>
          </span>
        </div>
      </aside>

      {wizardOpen ? <SetupWizard onClose={closeWizard} /> : null}
      <CommandPalette
        onNavigate={(path) => { window.location.hash = path; }}
        onSelectClip={(clipId) => {
          window.location.hash = "/review";
          window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent("tripcut:select-clip", { detail: clipId }));
          }, 120);
        }}
      />
      <main className="workspace">
        <header className="workspace-header compact">
          <div className="page-crumb">
            <span className="kicker">{content.kicker}</span>
            <strong>{documentTitleForRoute(route).split(" · ")[0]}</strong>
            <p className="page-hint">{content.description}</p>
          </div>
          <div className="header-actions">
            {route === "/review" ? (
              <button
                type="button"
                className="header-primary-action"
                title="为当前过滤下尚无描述的素材逐条生成 AI 描述(走预算确认)"
                onClick={() => window.dispatchEvent(new CustomEvent("tripcut:action", { detail: "select-describe-all" }))}
              >一键 AI 全读</button>
            ) : route === "/import" ? (
              <button
                type="button"
                className="header-primary-action"
                onClick={() => window.dispatchEvent(new CustomEvent("tripcut:action", { detail: "import-pick" }))}
              >＋ 选择素材文件夹</button>
            ) : route === "/deliver" ? (
              <button
                type="button"
                className="header-primary-action"
                disabled={!deliverAvailable}
                title={deliverAvailable ? "生成稳定交付包" : "请先收藏整条素材或保存精选片段"}
                onClick={() => window.dispatchEvent(new CustomEvent("tripcut:action", { detail: "deliver-export" }))}
              >生成交付包</button>
            ) : null}
            <button
              type="button"
              className="palette-hint"
              title="打开命令面板"
              onClick={() => window.dispatchEvent(new CustomEvent("tripcut:open-command-palette"))}
            >
              <kbd>⌘K</kbd> 命令面板
            </button>
          </div>
        </header>

        {route === "/import" ? (
          <ImportPage />
        ) : route === "/review" ? (
          <SelectPage />
        ) : route === "/deliver" ? (
          <DeliverPage />
        ) : route === "/settings" ? (
          <SettingsPage />
        ) : (
          <EmptyState>
            <span className="empty-index">{NAVIGATION.findIndex((item) => item.path === route) + 1}</span>
            <div className="empty-copy">
              <span className="empty-kicker">PLACEHOLDER VIEW</span>
              <h2>{content.emptyTitle}</h2>
              <p>{content.emptyBody}</p>
            </div>
            <span className="empty-rule" aria-hidden="true" />
          </EmptyState>
        )}

        <footer className="workspace-footer">
          <span>TRIPCUT / LOCAL-FIRST</span>
          <span>素材只读 · 项目可恢复</span>
        </footer>
      </main>
    </div>
  );
}

export default function App() {
  const route = useHashRoute();
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [doctorError, setDoctorError] = useState<string | undefined>();
  const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false);

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

  useEffect(() => {
    if (!workbenchReady) return;
    void getSettings()
      .then(applyAppearanceSettings)
      .catch(() => applyAppearanceSettings({}));
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
  return (
    <>
      <AppShell route={route} />
      <FirstRunGuide />
    </>
  );
}
