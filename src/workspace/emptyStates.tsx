import { useEffect, type JSX } from "react";
import { reportTeachingWant, useTeaching } from "./guides";
import { OPEN_AUTO_SELECT_EVENT } from "./onboarding";
import { arrangeIntoBand } from "./pipelineActions";
import { Button, EmptyState, type IconName } from "./ui";
import { usePipeline } from "./usePipeline";
import { dispatchWorkspace } from "./WorkspaceStore";

/**
 * 四栏空状态的文案与图标(规格 §3.4 的表),集中在一处:改一句话不用翻四个栏。
 * 栏本体(MediaPool / Monitor / ShotBand / inspectorFields)各自把旧占位换成下面
 * 对应的小组件 —— 这份文件只提供组件,不碰栏本体(并行车道各自接线)。
 */
export const EMPTY_COPY = {
  // R12 §1 第三条:空态按当前步说话 —— 媒体池空 = 第 ① 步。
  pool: { icon: "import", title: "第 ① 步:先导入", body: "还没有素材。选一个装着视频的文件夹,卡片会按拍摄时间出现在这里。" },
  poolFiltered: { icon: "search", title: "没有匹配的素材", body: "换个筛选条件或清空搜索。" },
  monitor: { icon: "play", title: "从左侧媒体池选一条素材", body: "选中后在这里预览,I / O 打点。" },
  // 镜头带空态按步分三句(BandEmpty 按 usePipeline 选):
  band: { icon: "film", title: "第 ① 步:先导入", body: "导入完成后会按拍摄时间自动生成章节。" },
  bandPick: { icon: "star", title: "第 ② 步:按 F 收藏或点自动挑选", body: "挑出来的片段会成为镜头带的候选镜。" },
  bandArrange: { icon: "slot", title: "第 ③ 步:把挑好的片段排进来", body: "一键按章节排好,顺序可以再拖。" },
  inspector: { icon: "info", title: "选一条素材查看详情", body: "评级、标签与技术检查都在这里。" },
} as const satisfies Record<string, { icon: IconName; title: string; body: string }>;

/**
 * 媒体池无素材(U-06):大号「导入素材」入口(R19 V-01 起 secondary,顶栏「下一步」才是实心主按钮)。AX 名是**新名**「导入第一批素材」——
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
          variant="secondary" // R19 V-01:空态入口降 secondary,首页 / 顶栏才是那颗实心主按钮
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
 * 镜头带空态(R11 简化专项 #5:一句话 + 一个按钮;R12 §1 第三条:按当前步说话)。
 * `no-chapters` 按流水线分三句:① 先导入 → 「打开导入」;② 按 F 收藏或点自动挑选 → 「去自动挑选」;
 * ③ 把挑好的片段排进来 → 「一键排入」(调车道 B 的 arrangeSelectedSegments)。
 * `no-gaps`:仅缺口视图下没有缺口 → 「回到按章节」。
 */
export function BandEmpty({ variant = "no-chapters", onAction }: { variant?: "no-chapters" | "no-gaps"; onAction?: () => void } = {}): JSX.Element {
  const pipeline = usePipeline();
  // R19 U-02:②③ 两句是教学(「按 F 收藏或点自动挑选」),归仲裁器;没拿到槽时卡片照在、按钮照在,只不带教学句。
  const teaching = variant === "no-chapters" && pipeline.step >= 2;
  useEffect(() => {
    reportTeachingWant("empty", teaching);
    return () => reportTeachingWant("empty", false);
  }, [teaching]);
  const slot = useTeaching("empty") && teaching;
  const teach = slot ? "empty" : undefined;
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
  if (pipeline.step >= 3) {
    const copy = EMPTY_COPY.bandArrange;
    return (
      <EmptyState
        teach={teach}
        icon={copy.icon}
        size="inline"
        title={copy.title}
        body={slot ? copy.body : undefined}
        className="band-empty-state"
        action={
          <Button variant="secondary" size="sm" icon="grip" onClick={() => void arrangeIntoBand().catch(() => undefined)}>
            一键排入
          </Button>
        }
      />
    );
  }
  if (pipeline.step === 2) {
    const copy = EMPTY_COPY.bandPick;
    return (
      <EmptyState
        teach={teach}
        icon={copy.icon}
        size="inline"
        title={copy.title}
        body={slot ? copy.body : undefined}
        className="band-empty-state"
        action={
          <Button variant="secondary" size="sm" icon="star" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_AUTO_SELECT_EVENT))}>
            去自动挑选
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
