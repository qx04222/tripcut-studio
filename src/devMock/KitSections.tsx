import { useState, type JSX, type ReactNode } from "react";
import {
  Badge, Button, Card, Chip, EmptyState, Field, ICON_NAMES, Icon, Kbd, SectionHeader, Select, Tabs, Toggle, Toolbar,
  type ButtonVariant,
} from "../workspace/ui";

/** 一个「示例块」:标签 + 内容,横排。 */
export function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="kit-row">
      <span className="kit-row-label">{label}</span>
      <div className="kit-row-body">{children}</div>
    </div>
  );
}

const VARIANTS: readonly ButtonVariant[] = ["primary", "secondary", "ghost", "icon"];
const STATES = ["默认", "禁用", "busy"] as const;

export function IconsSection(): JSX.Element {
  return (
    <div className="kit-icon-grid">
      {ICON_NAMES.map((name) => (
        <div key={name} className="kit-icon-cell">
          <Icon name={name} filled={name === "star" || name === "heart"} />
          <code>{name}</code>
        </div>
      ))}
    </div>
  );
}

export function ButtonsSection(): JSX.Element {
  return (
    <>
      {(["md", "sm"] as const).map((size) => (
        <Row key={size} label={`size=${size}`}>
          {VARIANTS.map((variant) =>
            STATES.map((state) => {
              const key = `${variant}-${state}`;
              const common = { variant, size, disabled: state === "禁用", busy: state === "busy" };
              return variant === "icon" ? (
                <Button key={key} {...common} icon="settings" aria-label={`设置 ${variant} ${state}`} />
              ) : (
                <Button key={key} {...common} icon={variant === "primary" ? "deliver" : undefined}>
                  {variant === "primary" ? "生成交付包" : variant === "secondary" ? "导入素材" : "更多"}
                </Button>
              );
            }),
          )}
        </Row>
      ))}
      <Row label="tone=danger">
        <Button tone="danger">删除本集</Button>
        <Button variant="primary" tone="danger">
          确认删除
        </Button>
        <Button variant="ghost" tone="danger" icon="x">
          清除
        </Button>
      </Row>
      <Row label="带 kbd / 按下态">
        <Button icon="import">
          导入素材 <Kbd>⌘I</Kbd>
        </Button>
        <Button variant="icon" icon="grip" aria-label="网格视图" aria-pressed="true" />
        <Button variant="icon" icon="settings-analysis" aria-label="列表视图" aria-pressed="false" />
      </Row>
    </>
  );
}

export function ChipsSection(): JSX.Element {
  const [selected, setSelected] = useState("all");
  const chips = [
    { id: "all", label: "全部", count: 60 },
    { id: "fav", label: "收藏", count: 11 },
    { id: "unrated", label: "未评", count: 37 },
    { id: "rejected", label: "拒绝", count: 4, tone: "danger" as const },
  ];
  return (
    <>
      <Row label="筛选 Chip">
        {chips.map((chip) => (
          <Chip key={chip.id} selected={selected === chip.id} count={chip.count} tone={chip.tone} onClick={() => setSelected(chip.id)}>
            {chip.label}
          </Chip>
        ))}
        <Chip icon="chevron-down" onClick={() => undefined}>
          更多筛选
        </Chip>
      </Row>
      <Row label="静态 / tone">
        <Chip>只读</Chip>
        <Chip tone="accent" icon="check">
          已同步
        </Chip>
        <Chip tone="warn" icon="warning" selected>
          缺口 1
        </Chip>
        <Chip tone="danger" selected>
          拒绝
        </Chip>
        <Chip onClick={() => undefined} disabled>
          禁用
        </Chip>
      </Row>
      <Row label="Badge">
        <Badge>2 条候选</Badge>
        <Badge tone="accent" icon="settings-generation">
          AI 生成
        </Badge>
        <Badge tone="warn" icon="warning">
          缺口 1
        </Badge>
        <Badge tone="danger">失败</Badge>
        <span className="kit-on-cover">
          <Badge tone="ink">00:27</Badge>
          <Badge tone="ink">Take 1/2</Badge>
        </span>
      </Row>
    </>
  );
}

export function CardsSection(): JSX.Element {
  return (
    <div className="kit-card-grid">
      <Card>
        <SectionHeader title="默认卡片" meta="padding 3" />
        <p className="kit-muted">圆角 10,card 阴影,发丝边。</p>
      </Card>
      <Card as="button" interactive aria-label="可交互卡片">
        <SectionHeader title="可交互" meta="hover 上浮" />
        <p className="kit-muted">hover 边变 strong,上浮 1px。</p>
      </Card>
      <Card as="button" interactive selected aria-label="选中卡片">
        <SectionHeader title="选中" meta="双圈强调环" />
        <p className="kit-muted">border 强调色 + ring-selected。</p>
      </Card>
      <Card level="raised" padding={4}>
        <SectionHeader title="浮层" meta="padding 4" />
        <p className="kit-muted">raised 阴影,popover / 拖动中的瓦片。</p>
      </Card>
    </div>
  );
}

export function FormSection(): JSX.Element {
  const [platform, setPlatform] = useState("generic");
  return (
    <div className="kit-form">
      <Field label="本次交付平台" htmlFor="kit-platform" help="不改本集设置,只影响这一次导出。">
        <Select id="kit-platform" value={platform} onChange={(event) => setPlatform(event.target.value)}>
          <option value="generic">通用</option>
          <option value="douyin">抖音</option>
          <option value="bilibili">B 站</option>
        </Select>
      </Field>
      <Field label="输出目录" htmlFor="kit-dir">
        <input id="kit-dir" className="kit-input" defaultValue="~/Movies/TripCut/EP01" />
        <Button variant="secondary" size="sm">
          选择…
        </Button>
      </Field>
      <Field label="说明" inline={false} help="堆叠式:标签在上,控件在下。">
        <textarea className="kit-input" rows={2} defaultValue="第一集:昆明到大理" aria-label="说明" />
      </Field>
    </div>
  );
}

export function TogglesSection(): JSX.Element {
  const [a, setA] = useState(true);
  const [b, setB] = useState(false);
  return (
    <>
      <Row label="Toggle">
        <Toggle checked={a} onChange={setA} label="联系表.pdf" />
        <Toggle checked={b} onChange={setB} label="剪映草稿" />
        <Toggle checked disabled onChange={() => undefined} label="禁用(开)" />
        <Toggle checked={false} disabled onChange={() => undefined} label="禁用(关)" />
      </Row>
      <Row label="Select">
        <Select aria-label="章节" defaultValue="1">
          <option value="1">01 出发:昆明到大理</option>
          <option value="2">02 洱海一日:双廊到喜洲</option>
        </Select>
        <Select aria-label="禁用" disabled defaultValue="x">
          <option value="x">禁用的 select</option>
        </Select>
      </Row>
    </>
  );
}

export function TabsSection(): JSX.Element {
  const [tab, setTab] = useState("jobs");
  return (
    <Tabs
      ariaLabel="导入分页"
      value={tab}
      onChange={setTab}
      items={[
        { id: "source", label: "来源" },
        { id: "jobs", label: "任务", count: 3 },
        { id: "missing", label: "缺失素材", count: 2 },
      ]}
    />
  );
}

export function ToolbarSection(): JSX.Element {
  return (
    <>
      <Row label="栏工具条">
        <Toolbar ariaLabel="媒体池工具" dense>
          <Button variant="icon" icon="grip" aria-label="网格" aria-pressed="true" />
          <Button variant="icon" icon="settings-analysis" aria-label="列表" />
          <Toolbar.Divider />
          <Button variant="icon" icon="search" aria-label="搜索" />
          <Toolbar.Spacer />
          <Button variant="ghost" size="sm" icon="plus">
            添加
          </Button>
        </Toolbar>
      </Row>
      <Row label="分组传输条(C 稿)">
        <Toolbar ariaLabel="走带" className="ui-toolbar--framed">
          <Button variant="icon" icon="prev" aria-label="上一镜" />
          <Button variant="primary" icon="play" aria-label="播放" />
          <Button variant="icon" icon="next" aria-label="下一镜" />
          <Toolbar.Divider />
          <span className="kit-timecode">
            00:00:12.480 <span className="kit-muted">/ 00:00:27.000</span>
          </span>
          <Toolbar.Divider />
          <Button variant="icon" icon="mark-in" aria-label="入点" aria-pressed="true" />
          <Button variant="icon" icon="mark-out" aria-label="出点" />
          <Button variant="secondary" size="sm" icon="save">
            保存片段
          </Button>
          <Toolbar.Spacer />
          <Button variant="icon" icon="volume" aria-label="音量" />
          <Button variant="ghost" size="sm" icon="fullscreen">
            全屏 <Kbd>⌘⏎</Kbd>
          </Button>
        </Toolbar>
      </Row>
    </>
  );
}

export function EmptySection(): JSX.Element {
  return (
    <div className="kit-empty-grid">
      <div className="kit-empty-frame">
        <EmptyState icon="import" title="还没有素材" body="导入一批素材后会出现在这里。" action={<Button variant="primary" icon="import">导入素材</Button>} />
      </div>
      <div className="kit-empty-frame kit-empty-frame--well">
        <EmptyState tone="dark" icon="play" title="选一条素材开始预览" body="在媒体池点击任意素材。" />
      </div>
      <div className="kit-empty-frame">
        <EmptyState size="inline" icon="search" title="没有匹配的素材" body="换个关键词试试。" />
      </div>
    </div>
  );
}
