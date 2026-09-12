import type { JSX, ReactNode } from "react";
import { SectionHeader } from "./ui";

/**
 * 四个栏共用的栏标题条(规格 §3.2):`SectionHeader size="pane"` —— 32px 铬条,
 * 13px 半粗中文栏标题,右侧计数/状态(`meta`)与图标工具槽(`actions`)。
 * 不是 heading —— 栏本身已经是带 aria-label 的 landmark,再加一层 heading 只会
 * 让读屏器把同一个名字念两遍。`monoMeta` 让文件名类 meta 走等宽 11px(A 稿 .fn)。
 * `children` 与 `actions` 一起落在右侧工具槽(镜头带的模式切换就在这)。
 */
export function PaneHead({
  title,
  meta,
  monoMeta = false,
  actions,
  children,
}: {
  title: string;
  meta?: ReactNode;
  monoMeta?: boolean;
  actions?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  const hasActions = actions !== undefined || children !== undefined;
  // 文件名类 meta 被 CSS 省略号截断后,全名挂在 title= 上悬停可读(R9 D3)。
  const metaNode = typeof meta === "string" ? <span title={meta}>{meta}</span> : meta;
  return (
    <SectionHeader
      size="pane"
      className={monoMeta ? "workspace-pane-chrome mono-meta" : "workspace-pane-chrome"}
      title={title}
      meta={metaNode}
      actions={
        hasActions ? (
          <>
            {actions}
            {children}
          </>
        ) : undefined
      }
    />
  );
}
