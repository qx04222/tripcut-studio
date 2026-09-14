import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * X-06(R12 验收):首启窗口曾经纯白几十秒。JS 跑起来之前 `#root` 里就要有一句占位,
 * 样式必须内联(样式表此时还没到),React 挂载时整块换掉(`createRoot(root).render` 会清空子树)。
 */
describe("index.html 的启动占位", () => {
  it("#root 里预置「正在准备工作台…」,role=status、内联样式、与 App 骨架同一个 AX 名", () => {
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    const root = html.slice(html.indexOf('<div id="root">'), html.indexOf("<script"));
    expect(root).toContain("正在准备工作台…");
    expect(root).toContain('role="status"');
    expect(root).toContain('aria-label="正在载入工作台"');
    expect(root).toMatch(/style="[^"]*height:100vh/);
  });
});
