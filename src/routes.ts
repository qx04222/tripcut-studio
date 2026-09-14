/**
 * R17 删除旧四页壳之后,这里只剩两件还在用的事:`routeFromHash`/`documentTitleForRoute`
 * 让浏览器标签标题继续跟 `#/import`、`#/review`、`#/deliver`、`#/settings` 这几个旧 hash
 * 走(`App.tsx` 用);真正的"打开哪个抽屉/sheet"转接逻辑不依赖本文件,由
 * `workspace/WorkspaceShell.tsx` 自己的 `drawerForLegacyHash` 处理并把 hash 收回 `#/`。
 * `NAVIGATION` 是旧壳侧边导航用过的文案表,旧壳删除后没有运行时引用了,留着是因为
 * 上面两个函数的文案(`documentTitleForRoute`)与它保持同源,拆开容易漂移。
 */
export type RoutePath = "/import" | "/review" | "/deliver" | "/settings";

export interface NavigationItem {
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

export function documentTitleForRoute(route: RoutePath): string {
  const labels: Record<RoutePath, string> = {
    "/import": "导入素材",
    "/review": "筛片工作台",
    "/deliver": "交付",
    "/settings": "设置与帮助",
  };
  return `${labels[route]} · 旅剪`;
}

export function routeFromHash(hash: string): RoutePath {
  const candidate = hash.replace(/^#/, "");
  return NAVIGATION.some((item) => item.path === candidate)
    ? (candidate as RoutePath)
    : "/import";
}
