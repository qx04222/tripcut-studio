/**
 * 旧四页壳的路由常量。单独成文件,好让 `App.tsx` 引用它们时**不必**静态引用
 * `LegacyShell.tsx`——后者是 `React.lazy()` 的目标,任何一条静态引用都会把整个
 * 旧壳(以及它拖着的 ImportPage/SelectPage/DeliverPage/SettingsPage)拉回首屏 chunk。
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
