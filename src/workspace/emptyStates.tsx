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

/**
 * 媒体池无素材(U-06):大号 primary「导入素材」入口。AX 名是**新名**「导入第一批素材」——
 * 「导入素材」是顶栏按钮的冻结名,壳测试与真机冒烟按名字找它,空池时两颗同名会撞。
 */
export function PoolEmpty(): JSX.Element {
  const copy = EMPTY_COPY.pool;
  return (
    <EmptyState
      icon={copy.icon}
      title={copy.title}
      body={copy.body}
      className="pool-empty-state"
      action={
        <Button
          variant="primary"
          icon="import"
          aria-label="导入第一批素材"
          aria-haspopup="dialog"
          onClick={() => dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "source" })}
        >
          导入素材
        </Button>
      }
    />
  );
}

/**
 * 媒体池筛选无命中:「清空筛选」把 filter 拨回 all;`onReset` 让媒体池顺带清掉
 * 搜索词、八维与「更多筛选」(U-06)—— 只拨 filter 时搜索词还挂着,池仍是空的。
 */
export function PoolFilteredEmpty({ onReset }: { onReset?: () => void } = {}): JSX.Element {
  const copy = EMPTY_COPY.poolFiltered;
  return (
    <EmptyState
      icon={copy.icon}
      title={copy.title}
      body={copy.body}
      action={
        <Button
          variant="ghost"
          onClick={() => {
            dispatchWorkspace({ type: "set-filter", filter: "all" });
            onReset?.();
          }}
        >
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

/**
 * 镜头带空态(R11 简化专项 #5:一句话 + 一个按钮)。
 * `no-chapters`:还没有章节 → 「打开导入」;`no-gaps`:仅缺口视图下没有缺口 → 「回到按章节」。
 */
export function BandEmpty({ variant = "no-chapters", onAction }: { variant?: "no-chapters" | "no-gaps"; onAction?: () => void } = {}): JSX.Element {
  if (variant === "no-gaps") {
    return (
      <EmptyState
        icon="check"
        size="inline"
        title="所有章节都没有缺口"
        body="每一章都有素材可用。"
        className="band-empty-state"
        action={
          <Button variant="ghost" size="sm" onClick={onAction}>
            回到按章节
          </Button>
        }
      />
    );
  }
  const copy = EMPTY_COPY.band;
  return (
    <EmptyState
      icon={copy.icon}
      size="inline"
      title={copy.title}
      body={copy.body}
      className="band-empty-state"
      action={
        <Button
          variant="ghost"
          size="sm"
          icon="import"
          aria-haspopup="dialog"
          onClick={() => dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "source" })}
        >
          打开导入
        </Button>
      }
    />
  );
}

/** 检查器未选中。 */
export function InspectorEmpty(): JSX.Element {
  const copy = EMPTY_COPY.inspector;
  return <EmptyState icon={copy.icon} title={copy.title} body={copy.body} />;
}
