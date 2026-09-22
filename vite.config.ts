import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { defineConfig, type Plugin, type PluginOption } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * `vite --mode mock` 要换掉的四个 Tauri 入口(`src/devMock/viteMock.test.ts` 对账):
 * `@tauri-apps/api/core` 是 `src/api.ts` 130 条 `invoke` 的唯一来源;`webview` 是导入页
 * 的拖放事件;两个 plugin 是设置 sheet 的更新检查。别的 Tauri 入口本仓库没用。
 */
export const MOCK_ALIAS_TARGETS: Readonly<Record<string, string>> = {
  "@tauri-apps/api/core": "src/devMock/core.ts",
  "@tauri-apps/api/webview": "src/devMock/webview.ts",
  "@tauri-apps/plugin-updater": "src/devMock/pluginUpdater.ts",
  "@tauri-apps/plugin-process": "src/devMock/pluginProcess.ts",
};

export function mockAliases(root: string): { find: string; replacement: string }[] {
  return Object.entries(MOCK_ALIAS_TARGETS).map(([find, target]) => ({
    find,
    replacement: resolve(root, target),
  }));
}

/**
 * 从 `qa/mock-covers/`(不入库,`scripts/qa/make-mock-covers.mjs` 生成)托管
 * `/mock-covers/*.jpg`。**不放进 `public/`**:public 会被生产 build 原样拷进 dist,
 * 60 张假封面就跟着进了安装包。
 */
export function mockCoversMiddleware(coversDir: string): Plugin {
  return {
    name: "tripcut-mock-covers",
    configureServer(server) {
      server.middlewares.use("/mock-covers", (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/"));
        if (rel.includes("..") || !rel.endsWith(".jpg")) {
          next();
          return;
        }
        const file = join(coversDir, rel);
        if (!existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          res.end(`mock cover missing: ${rel} — run node scripts/qa/make-mock-covers.mjs`);
          return;
        }
        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Cache-Control", "no-store");
        createReadStream(file).pipe(res);
      });
    },
  };
}

/**
 * `vite --mode mock`(`npm run preview:workspace`):把 `@tauri-apps/api/core` 等四个
 * Tauri 入口换成 `src/devMock/` 下的内存假后端,工作区就能在普通浏览器/无头 Chromium
 * 里跑起来给截图装置看。**只有** mode === "mock" 才装这组 alias —— 生产 build 与
 * `vite dev` 一行都不变(`src/devMock/viteMock.test.ts` 断言这一点)。
 */
const ROOT = import.meta.dirname;

export default defineConfig(({ mode }) => {
  const mock = mode === "mock";
  const plugins: PluginOption[] = [react()];
  if (mock) plugins.push(mockCoversMiddleware(resolve(ROOT, "qa/mock-covers")));
  return {
    plugins,
    resolve: mock ? { alias: mockAliases(ROOT) } : undefined,
    test: {
      exclude: [...configDefaults.exclude, "src-tauri/target/**"],
      setupFiles: ["./src/test-setup.ts"],
    },
    clearScreen: false,
    server: {
      host: "127.0.0.1",
      port: 1420,
      strictPort: true,
    },
    envPrefix: ["VITE_", "TAURI_ENV_"],
    build: {
      target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
      minify: !process.env.TAURI_ENV_DEBUG,
      sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
      // Vite 8 runs on rolldown, whose deprecated `manualChunks` maps 1:1 onto
      // `output.codeSplitting.groups` (rollup's function form is not supported
      // here, only string/regex `test`) — see rolldown OutputOptions docs.
      // Split the three heaviest page modules and the two heaviest deps into
      // their own chunks so no single chunk crosses chunkSizeWarningLimit.
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              // 套件(R9 Task 1)是首屏与三个懒加载模态共用的,先认领成自己的块。
              { name: "ui-kit", test: /[\\/]src[\\/]workspace[\\/]ui[\\/]/ },
              // 首屏与懒加载块共用的那几个模块必须先被认领(R8 终审 M1)。不认领的话
              // rolldown 会把它们顺手塞进第一个用到它们的 group chunk——上一版
              // `settings` 块里就装着 WorkspaceStore/uiSettings/appearance/Drawer,
              // 于是 index 又静态 import 了 `settings-*.js`,设置 sheet 的 lazy() 白写。
              {
                name: "app-core",
                test: /[\\/]src[\\/](api|appearance|useFocusTrap|kindLabels|historyView|toolchainSteps)\.tsx?$|[\\/]src[\\/]workspace[\\/](uiSettings|WorkspaceStore|modalStack|useGlobalDrop)\.tsx?$/,
              },
              { name: "vendor-dnd", test: /node_modules[\\/]@dnd-kit/ },
              // 三栏布局库是新壳首屏就要用的;不点名它就被吸进 `select-legacy` 块,
              // 结果 index 静态 import 了整张旧筛片页所在的 chunk。
              { name: "vendor-panels", test: /node_modules[\\/]react-resizable-panels/ },
              { name: "vendor-cmdk", test: /node_modules[\\/]cmdk/ },
              // 以下按新 IA 分组(规格 §9)。**顺序有实义**:实测把 `workspace`
              // 这条(壳本体)放在 pool/monitor/band/inspector 之前,rolldown 会把
              // 那四块全部并进 `workspace` 一个 161 kB 的 chunk,四条 group 一条都不
              // materialize —— 构建日志里只是"少了几行",不报错。壳本体放到最后,
              // 八个 chunk 才各自成块。改动这段顺序后必须重跑 scripts/qa/check-chunks.mjs
              // 并肉眼核对产物清单里这八个名字都在。
              { name: "pool", test: /[\\/]src[\\/]workspace[\\/](MediaPool|PoolFilters|poolModel)\./ },
              { name: "monitor", test: /[\\/]src[\\/](workspace[\\/](Monitor|MonitorControls)|PlayerOverlay)\./ },
              {
                name: "band",
                test: /[\\/]src[\\/](workspace[\\/](ShotBand|BandAccessory|BandChapters|BandSegment|MusicRuler|shotBandModel|useBandDrag)|Storyboard)\./,
              },
              {
                name: "inspector",
                test: /[\\/]src[\\/]workspace[\\/](Inspector|InspectorSections|inspectorFields|inspectorModel)\./,
              },
              {
                name: "workspace",
                test: /[\\/]src[\\/]workspace[\\/](WorkspaceShell|TopBar|StatusStrip|useClipsFeed|useSelection|useGlobalHotkeys)\./,
              },
              {
                name: "drawers",
                test: /[\\/]src[\\/](ImportPage|ImportManagement|MissingMediaPanel|DeliverPage|workspace[\\/](ImportDrawer|DeliverDrawer|EpisodeSwitcher)\.|workspace[\\/](deliver|import)[\\/])/,
              },
              { name: "settings", test: /[\\/]src[\\/](SettingsPage|workspace[\\/]SettingsSheet)\.|[\\/]src[\\/]workspace[\\/]settings[\\/]/ },
              // 旧壳(0.3.0 期间与新壳共存,R9 删)。
              { name: "select-legacy", test: /[\\/]src[\\/]SelectPage\.tsx/ },
            ],
          },
        },
      },
    },
  };
});
