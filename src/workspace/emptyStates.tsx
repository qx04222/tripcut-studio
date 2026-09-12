import type { JSX } from "react";
import { Button, EmptyState, type IconName } from "./ui";
import { dispatchWorkspace } from "./WorkspaceStore";

/**
 * 四栏空状态的文案与图标(规格 §3.4 的表),集中在一处:改一句话不用翻四个栏。
 * 栏本体(MediaPool / Monitor / ShotBand / inspectorFields)各自把旧占位换成下面
 * 对应的小组件 —— 这份文件只提供组件,不碰栏本体(并行车道各自接线)。
 */
export const EMPTY_COPY = {
  pool: { icon: "import", title: "还没有素材", body: "导入一批素材后,卡片会按拍摄时间出现在这里。" },
  poolFiltered: { icon: "search", title: "没有匹配的素材", body: "换个筛选条件或清空搜索。" },
  monitor: { icon: "play", title: "从左侧媒体池选一条素材", body: "选中后在这里预览,I / O 打点。" },
  band: { icon: "grip", title: "还没有章节", body: "导入完成后会按拍摄时间自动生成章节。" },
  inspector: { icon: "info", title: "选一条素材查看详情", body: "评级、标签与技术检查都在这里。" },
} as const satisfies Record<string, { icon: IconName; title: string; body: string }>;

/** 媒体池无素材:带「导入素材」(与顶栏同名 —— 只在空池时渲染,非空池主屏仍只有一个同名按钮)。 */
export function PoolEmpty(): JSX.Element {
  const copy = EMPTY_COPY.pool;
  return (
    <EmptyState
      icon={copy.icon}
      title={copy.title}
      body={copy.body}
      action={
        <Button
          variant="secondary"
          icon="import"
          aria-haspopup="dialog"
          onClick={() => dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "source" })}
        >
          导入素材
        </Button>
      }
    />
  );
}

/** 媒体池筛选无命中:「清空筛选」把 filter 拨回 all。 */
export function PoolFilteredEmpty(): JSX.Element {
  const copy = EMPTY_COPY.poolFiltered;
  return (
    <EmptyState
      icon={copy.icon}
      title={copy.title}
      body={copy.body}
      action={
        <Button variant="ghost" onClick={() => dispatchWorkspace({ type: "set-filter", filter: "all" })}>
          清空筛选
        </Button>
      }
    />
  );
}

/** 监视器未选中:压在井底上(tone dark);标题句 R8 Monitor.test 已断言,原句保留。 */
export function MonitorEmpty(): JSX.Element {
  const copy = EMPTY_COPY.monitor;
  return <EmptyState icon={copy.icon} title={copy.title} body={copy.body} tone="dark" />;
}

/** 镜头带无章节。 */
export function BandEmpty(): JSX.Element {
  const copy = EMPTY_COPY.band;
  return <EmptyState icon={copy.icon} title={copy.title} body={copy.body} />;
}

/** 检查器未选中。 */
export function InspectorEmpty(): JSX.Element {
  const copy = EMPTY_COPY.inspector;
  return <EmptyState icon={copy.icon} title={copy.title} body={copy.body} />;
}
