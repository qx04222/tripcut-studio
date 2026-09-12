import type { JSX } from "react";
import { EpisodeSwitcher } from "./EpisodeSwitcher";
import { Button, Icon, Kbd } from "./ui";
import { dispatchWorkspace, useWorkspace } from "./WorkspaceStore";

/**
 * 顶栏(高 44px,规格 §3.1)。左起品牌记号 + 字标 + 「导入素材」,居中「切换集」胶囊,
 * 右侧「命令面板 ⌘K」提示、「生成交付包」(唯一的强调色主按钮)与齿轮「设置」。
 * **没有四步导航,没有英文 kicker** —— 旧壳那四条「01 导入 INGEST」式导航在新壳里
 * 一条都不许出现,冒烟脚本按这个断言。四个按钮的 AX 名(导入素材 / 切换集 /
 * 生成交付包 / 设置)冻结;键帽提示(⌘I / ⌘⏎ / ⌘K)是 `aria-hidden` 的视觉引导,
 * 不进 AX 名。
 */
export function TopBar(): JSX.Element {
  const openDrawer = useWorkspace((state) => state.openDrawer);

  return (
    <header className="workspace-topbar">
      <div className="workspace-topbar-left">
        <span className="workspace-brand">
          <span className="workspace-brand-mark" aria-hidden="true">
            <Icon name="play" size={12} />
          </span>
          <span className="workspace-wordmark">旅剪工作台</span>
        </span>
        <Button
          variant="secondary"
          icon="import"
          aria-haspopup="dialog"
          aria-expanded={openDrawer === "import"}
          aria-label="导入素材"
          onClick={() => dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "source" })}
        >
          导入素材
          <Kbd>⌘I</Kbd>
        </Button>
      </div>

      <div className="workspace-topbar-center">
        <EpisodeSwitcher />
      </div>

      <div className="workspace-topbar-right">
        <span className="workspace-topbar-hint" aria-hidden="true">
          命令面板
          <Kbd>⌘K</Kbd>
        </span>
        <Button
          variant="primary"
          icon="deliver"
          aria-haspopup="dialog"
          aria-expanded={openDrawer === "deliver"}
          aria-label="生成交付包"
          onClick={() => dispatchWorkspace({ type: "open-drawer", drawer: "deliver" })}
        >
          生成交付包
          <Kbd>⌘⏎</Kbd>
        </Button>
        <Button
          variant="icon"
          icon="settings"
          aria-haspopup="dialog"
          aria-expanded={openDrawer === "settings"}
          aria-label="设置"
          title="设置 ⌘,"
          onClick={() => dispatchWorkspace({ type: "open-drawer", drawer: "settings" })}
        />
      </div>
    </header>
  );
}
