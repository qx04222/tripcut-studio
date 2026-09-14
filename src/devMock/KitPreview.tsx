import { useState, type JSX, type ReactNode } from "react";
import { Button, Card, Chip, Drawer, Field, Kbd, SectionHeader, Select, Sheet, Toggle } from "../workspace/ui";
import {
  ButtonsSection, CardsSection, ChipsSection, EmptySection, FormSection, IconsSection, Row, TabsSection, TogglesSection, ToolbarSection,
} from "./KitSections";

/** kitchen-sink 分节名(中文);src/devMock/kitPreview.test.tsx 按 region 名逐一找。 */
export const KIT_SECTIONS: readonly string[] = [
  "图标", "按钮", "Chip 与 Badge", "卡片", "节标题", "表单", "Toggle 与 Select", "Tabs", "工具条", "空状态", "Kbd", "抽屉与 Sheet", "深色",
];

function Section({ name, children }: { name: string; children: ReactNode }): JSX.Element {
  return (
    <section aria-label={name} className="kit-section">
      <SectionHeader title={name} />
      {children}
    </section>
  );
}

function KbdSection(): JSX.Element {
  const keys = ["/", "F", "X", "1", "2", "3", "4", "5", "0", "[", "]", "⌘K", "?"];
  return (
    <Row label="全局引导">
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
      <span className="kit-muted">
        按 <Kbd>/</Kbd> 搜索,<Kbd>F</Kbd> 收藏,<Kbd>X</Kbd> 拒绝
      </span>
    </Row>
  );
}

function ModalsSection(): JSX.Element {
  const [open, setOpen] = useState<"left" | "right" | "sheet" | null>(null);
  const [pdf, setPdf] = useState(true);
  const close = () => setOpen(null);
  return (
    <>
      <Row label="打开真实模态">
        <Button onClick={() => setOpen("left")}>打开左侧抽屉</Button>
        <Button onClick={() => setOpen("right")}>打开右侧抽屉</Button>
        <Button onClick={() => setOpen("sheet")}>打开 Sheet</Button>
      </Row>
      <Drawer open={open === "left"} title="导入素材" side="left" width="min(720px, 60vw)" onClose={close} actions={<Button size="sm" icon="search">立即扫描</Button>}>
        <div className="kit-modal-body">
          <TabsSection />
          <p className="kit-muted">抽屉正文:Task 5 换成原生内容。按 Esc、点遮罩或右上「关闭」都能关。</p>
        </div>
      </Drawer>
      <Drawer open={open === "right"} title="导出" side="right" width="min(720px, 60vw)" onClose={close} actions={<Button variant="primary" size="sm" icon="deliver">生成</Button>}>
        <div className="kit-modal-body kit-form">
          <Field label="本次交付平台" htmlFor="kit-modal-platform" help="不改本集设置。">
            <Select id="kit-modal-platform" defaultValue="generic">
              <option value="generic">通用</option>
              <option value="douyin">抖音</option>
            </Select>
          </Field>
          <Field label="联系表.pdf">
            <Toggle checked={pdf} onChange={setPdf} label="联系表.pdf" />
            <span className="kit-muted">每镜一格的缩略图总表</span>
          </Field>
        </div>
      </Drawer>
      <Sheet open={open === "sheet"} title="设置" onClose={close}>
        <div className="kit-modal-body">
          <p className="kit-muted">Sheet 正文:居中 960 × 80vh。Task 7 换成原生九分区。</p>
        </div>
      </Sheet>
    </>
  );
}

function DarkSection(): JSX.Element {
  return (
    <div data-theme="dark" className="kit-dark">
      <Row label="按钮">
        <Button variant="primary" icon="deliver">
          生成交付包
        </Button>
        <Button icon="import">导入素材</Button>
        <Button variant="ghost">更多</Button>
        <Button variant="icon" icon="settings" aria-label="设置(深色)" />
        <Button disabled>禁用</Button>
      </Row>
      <Row label="Chip">
        <Chip selected count={60} onClick={() => undefined}>
          全部
        </Chip>
        <Chip count={11} onClick={() => undefined}>
          收藏
        </Chip>
        <Chip tone="warn" icon="warning" selected>
          缺口 1
        </Chip>
        <Kbd>⌘K</Kbd>
      </Row>
      <div className="kit-card-grid">
        <Card>
          <SectionHeader title="深色卡片" meta="1px 边代替阴影" />
          <p className="kit-muted">深色下 shadow-card 换成 0 0 0 1px border。</p>
        </Card>
        <Card as="button" interactive selected aria-label="深色选中卡片">
          <SectionHeader title="选中" meta="ring-selected" />
          <p className="kit-muted">强调色在深色调色板里是 #caf24f 那一档。</p>
        </Card>
      </div>
    </div>
  );
}

export function KitPreview(): JSX.Element {
  return (
    <main className="kit-page">
      <header className="kit-header">
        <h1>TripCut 套件预览</h1>
        <p className="kit-muted">R9 Task 1 · 令牌 + 组件套件 kitchen-sink。基准:A「编辑台密度」。</p>
      </header>
      <Section name="图标">
        <IconsSection />
      </Section>
      <Section name="按钮">
        <ButtonsSection />
      </Section>
      <Section name="Chip 与 Badge">
        <ChipsSection />
      </Section>
      <Section name="卡片">
        <CardsSection />
      </Section>
      <Section name="节标题">
        <Row label="size=pane(32px 铬条)">
          <div className="kit-pane-frame">
            <SectionHeader size="pane" title="媒体池" meta="51 / 60 条" actions={<Button variant="icon" size="sm" icon="grip" aria-label="网格视图" />} />
          </div>
        </Row>
        <Row label="size=section(15px h3)">
          <SectionHeader title="本次交付" meta="3 项" description="按平台默认勾选,可逐项关闭。" actions={<Button size="sm">全选</Button>} />
        </Row>
      </Section>
      <Section name="表单">
        <FormSection />
      </Section>
      <Section name="Toggle 与 Select">
        <TogglesSection />
      </Section>
      <Section name="Tabs">
        <TabsSection />
      </Section>
      <Section name="工具条">
        <ToolbarSection />
      </Section>
      <Section name="空状态">
        <EmptySection />
      </Section>
      <Section name="Kbd">
        <KbdSection />
      </Section>
      <Section name="抽屉与 Sheet">
        <ModalsSection />
      </Section>
      <Section name="深色">
        <DarkSection />
      </Section>
    </main>
  );
}
