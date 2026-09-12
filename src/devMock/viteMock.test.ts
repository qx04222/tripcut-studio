import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import viteConfig, { MOCK_ALIAS_TARGETS, mockAliases } from "../../vite.config";

type ConfigFn = (env: { mode: string; command: "build" | "serve"; isSsrBuild?: boolean; isPreview?: boolean }) => {
  resolve?: { alias?: unknown };
  plugins?: unknown[];
};

const resolveConfig = viteConfig as unknown as ConfigFn;

describe("vite mock mode", () => {
  it("installs the Tauri aliases only when mode === \"mock\"", () => {
    for (const mode of ["production", "development", "test"]) {
      const config = resolveConfig({ mode, command: mode === "production" ? "build" : "serve" });
      expect(config.resolve, mode).toBeUndefined();
      expect(config.plugins?.some((p) => (p as { name?: string })?.name === "tripcut-mock-covers"), mode).toBe(false);
    }
    const mock = resolveConfig({ mode: "mock", command: "serve" });
    expect(mock.resolve?.alias).toEqual(mockAliases("/x").map(({ find, replacement }) => ({ find, replacement: expect.stringMatching(new RegExp(`${replacement.slice(2)}$`)) })));
    expect(mock.plugins?.some((p) => (p as { name?: string })?.name === "tripcut-mock-covers")).toBe(true);
  });

  it("aliases exactly the four Tauri entry points the frontend imports", () => {
    expect(Object.keys(MOCK_ALIAS_TARGETS).sort()).toEqual([
      "@tauri-apps/api/core",
      "@tauri-apps/api/webview",
      "@tauri-apps/plugin-process",
      "@tauri-apps/plugin-updater",
    ]);
  });

  it("kit.html 只在 mock 模式可访问,生产 build 不把它当入口", () => {
    const prod = resolveConfig({ mode: "production", command: "build" }) as { build?: { rolldownOptions?: { input?: unknown } } };
    expect(prod.build?.rolldownOptions?.input).toBeUndefined();
    expect(existsSync(resolve(process.cwd(), "kit.html"))).toBe(true);
  });

  it("ui-kit 是第一条 chunk 分组,app-core 不再认领已删除的 workspace/Drawer", () => {
    const prod = resolveConfig({ mode: "production", command: "build" }) as {
      build?: { rolldownOptions?: { output?: { codeSplitting?: { groups?: { name: string; test: RegExp }[] } } } };
    };
    const groups = prod.build?.rolldownOptions?.output?.codeSplitting?.groups ?? [];
    expect(groups[0]?.name).toBe("ui-kit");
    expect(groups[0]?.test.test("/x/src/workspace/ui/Button.tsx")).toBe(true);
    const core = groups.find((g) => g.name === "app-core")!;
    expect(core.test.test("/x/src/workspace/Drawer.tsx")).toBe(false);
    expect(core.test.test("/x/src/workspace/modalStack.ts")).toBe(true);
  });
});
