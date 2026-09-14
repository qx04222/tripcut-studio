import type { AiDescriptionResult, ClipListItem, ShotStack } from "../api";
import { activeRatingValue, ratingLabelFor, sortTakeMembers, takeDateLabel, type SlotOption } from "./inspectorModel";
import { ActionKbd } from "./KeymapKbd";
import { Badge, Button, Card, Chip, CoverImage, Field, Icon, Select } from "./ui";
import { stackGroupLabel } from "./copy";

/**
 * 检查器共用的展示片段(同 Task 2 `poolModel.ts` 的技术):旧壳
 * `SelectPage.tsx` 的 `SelectionInspector` 与新壳 `Inspector.tsx` 都从这里取,
 * 行为只维护一份。`RatingDisplay` / `AiDescriptionSection` 的标签 DOM 是从
 * `SelectPage.tsx` **逐字**搬来的——`SelectPage.test.tsx` 没有断言到这两块,
 * 但逐字搬运仍是这里的纪律,以防将来补断言时打脸。
 */

/** 旧壳的只读评星展示(SelectionInspector「评级」段)。 */
export function RatingDisplay({ clip }: { clip: ClipListItem }) {
  const star = activeRatingValue(clip.star_rating);
  return (
    <div className="inspector-rating">
      <span>评级</span>
      <strong>{ratingLabelFor(clip)}</strong>
      <div aria-label={star === null ? "未评星" : `${star} 星`}>
        {Array.from({ length: 5 }, (_, index) => (
          <span className={star !== null && index < star ? "filled" : undefined} key={index}>
            ★
          </span>
        ))}
      </div>
    </div>
  );
}

/** 旧壳的 AI 描述段,逐字保留;新壳「AI 描述」折叠段内容也是它。 */
export function AiDescriptionSection({
  aiDescription,
  llmEnabled,
  llmBudgetExhausted,
  aiBusy,
  onDescribe,
  onOpenSettings,
}: {
  aiDescription: AiDescriptionResult | null;
  llmEnabled: boolean;
  llmBudgetExhausted: boolean;
  aiBusy: boolean;
  onDescribe: () => void;
  /** R10 U-14:未启用时旁边给「去设置」(新壳传 openSettings("analysis");旧壳不传就不显示)。 */
  onOpenSettings?: () => void;
}) {
  return (
    <div className="inspector-section inspector-ai-description">
      <span>AI 描述 · 可选的增强分析</span>
      {aiDescription ? (
        <div className="ai-description-result">
          <p>{aiDescription.description}</p>
          <div>
            {aiDescription.tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
          <small>由 {aiDescription.provider} 返回;3 个标签已写入</small>
        </div>
      ) : (
        <p>
          {!llmEnabled
            ? "设置页开启后才可调用。"
            : llmBudgetExhausted
              ? "本月预算已用尽，后端熔断且不会启动 CLI。"
              : "只发送文件名和基础分析数值,不发送画面或原片。"}
        </p>
      )}
      <div className="inspector-ai-actions">
        <button type="button" disabled={!llmEnabled || llmBudgetExhausted || aiBusy} onClick={onDescribe}>
          {aiBusy
            ? "生成中…"
            : llmBudgetExhausted
              ? "预算已熔断"
              : aiDescription
                ? "重新生成 AI 描述"
                : "生成 AI 描述"}
        </button>
        {!llmEnabled && onOpenSettings ? (
          <Button variant="ghost" size="sm" onClick={onOpenSettings}>
            去设置
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 「标签」段——常驻(R10 U-12):有标签列 Chip,没有就说「还没有标签」;「添加标签」始终在,
 * 但 `api.ts` 没有手动打标签的写接口,所以是禁用态 —— 入口可见而不假装能用(业主决策,不是漏做)。
 */
export function TagsSection({ aiDescription }: { aiDescription: AiDescriptionResult | null }) {
  const tags = aiDescription?.tags ?? [];
  return (
    <div className="inspector-tag-list">
      {tags.length === 0 ? <span className="inspector-tag-empty">还没有标签；生成 AI 描述会写入 3 个标签</span> : null}
      {tags.map((tag) => (
        <Chip key={tag}>{tag}</Chip>
      ))}
      <Button variant="ghost" size="sm" icon="plus" className="inspector-tag-add" disabled title="暂不支持手动标签">
        添加标签
      </Button>
    </div>
  );
}

/**
 * 「所属章节 / 槽位」段——两行带标签的下拉(A 稿):章节在叙事模式下可改派 beat,
 * 不可改时是禁用的单选;槽位 = 同章内的位次,改选走镜头带同一条 planBandReorder 写入路径。
 */
export function ChapterSlotSection({
  chapterTitle,
  canReassign,
  chapterOptions,
  currentChapterId,
  slotOptions,
  currentSlotKey,
  readOnly,
  onMoveChapter,
  onMoveSlot,
  onAddToBand,
  addBusy = false,
}: {
  chapterTitle: string | null;
  canReassign: boolean;
  chapterOptions: readonly { id: number; title: string }[];
  currentChapterId: number | null;
  slotOptions: readonly SlotOption[];
  currentSlotKey: string | null;
  readOnly: boolean;
  onMoveChapter: (chapterId: number) => void;
  onMoveSlot: (targetKey: string) => void;
  /**
   * 「加入当前章节」(R10 U-12 / U-18):素材还不在镜头带上时的入口 —— 不靠拖拽的第二条路,
   * 走 `useBandDrag.insert`(与拖排同一条 set_story_order 路径)。给了才渲染。
   */
  onAddToBand?: () => void;
  addBusy?: boolean;
}) {
  const onBand = currentChapterId !== null || currentSlotKey !== null;
  return (
    <div className="inspector-placement">
      {!onBand && onAddToBand ? (
        <div className="inspector-placement-add">
          <span className="inspector-placement-empty">还没有编入镜头带</span>
          <Button size="sm" icon="plus" disabled={readOnly || addBusy} busy={addBusy} onClick={onAddToBand}>
            加入当前章节
          </Button>
        </div>
      ) : null}
      <Field label="章节" htmlFor="inspector-chapter-select">
        <Select
          id="inspector-chapter-select"
          aria-label="改写所属章节"
          value={currentChapterId ?? ""}
          disabled={readOnly || !canReassign}
          onChange={(event) => onMoveChapter(Number(event.currentTarget.value))}
        >
          {canReassign ? (
            chapterOptions.map((chapter) => (
              <option value={chapter.id} key={chapter.id}>
                {chapter.title}
              </option>
            ))
          ) : (
            <option value={currentChapterId ?? ""}>{chapterTitle ?? "尚未编入章节"}</option>
          )}
        </Select>
      </Field>
      {slotOptions.length > 0 && currentSlotKey !== null ? (
        <Field label="槽位" htmlFor="inspector-slot-select">
          <Select
            id="inspector-slot-select"
            aria-label="改写槽位"
            value={currentSlotKey}
            disabled={readOnly || slotOptions.length < 2}
            onChange={(event) => onMoveSlot(event.currentTarget.value)}
          >
            {slotOptions.map((option) => (
              <option value={option.key} key={option.key}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
    </div>
  );
}

/** 「同镜头 Take 切换」段——横向缩略图卡 96×54(A 稿),当前项强调环;生成片排在真实素材之后并带「AI 生成」Badge。 */
export function TakeSwitcher({
  stack,
  clipsById,
  selectedClipId,
  onSelect,
}: {
  stack: ShotStack;
  clipsById: ReadonlyMap<number, ClipListItem>;
  selectedClipId: number | null;
  onSelect: (clipId: number) => void;
}) {
  const ordered = sortTakeMembers(stack.members, clipsById);
  return (
    <div className="inspector-take-strip" role="group" aria-label={stackGroupLabel(stack.scene_name)}>
      {ordered.map((member, index) => {
        const memberClip = clipsById.get(member.clip_id);
        const generated = Boolean(memberClip?.generated_source);
        const selected = member.clip_id === selectedClipId;
        const date = memberClip ? takeDateLabel(memberClip) : null;
        return (
          <Card
            as="button"
            interactive
            selected={selected}
            key={member.clip_id}
            className="inspector-take-card"
            aria-current={selected ? "true" : undefined}
            onClick={() => onSelect(member.clip_id)}
          >
            <span className="inspector-take-thumb" aria-hidden="true">
              <CoverImage src={memberClip?.cover_url} />
              {generated ? (
                <Badge tone="accent" className="inspector-take-ai">
                  AI 生成
                </Badge>
              ) : null}
              {member.user_state === "hero" ? (
                <Badge tone="ink" className="inspector-take-hero">
                  首选
                </Badge>
              ) : null}
            </span>
            <span className="inspector-take-caption">
              <span className="inspector-take-order">{`第 ${index + 1} 条`}</span>
              {date ? <span className="inspector-take-date">{date}</span> : null}
            </span>
            <span className="inspector-take-name" title={memberClip?.file_name}>
              {memberClip?.file_name ?? `Clip ${member.clip_id}`}
            </span>
          </Card>
        );
      })}
    </div>
  );
}

const STAR_VALUES = [1, 2, 3, 4, 5] as const;

/** 「评级与收藏」段——收藏 / 拒绝 / 清除 = 分段的 secondary sm 按钮(带 Kbd),五星 = icon 按钮;与 F / X / 1–5 / 0 快捷键同义。 */
export function RatingControls({
  clip,
  busy,
  onRate,
  onClear,
}: {
  clip: ClipListItem;
  busy: boolean;
  onRate: (kind: "binary" | "star", value: number) => void;
  onClear: () => void;
}) {
  const binary = activeRatingValue(clip.binary_rating);
  const star = activeRatingValue(clip.star_rating);
  return (
    <div className="inspector-rating-row">
      <div className="inspector-rating-segment" role="group" aria-label="收藏与拒绝">
        <Button
          size="sm"
          className={binary === 1 ? "is-on" : undefined}
          disabled={busy}
          aria-label="收藏"
          aria-pressed={binary === 1}
          onClick={() => onRate("binary", 1)}
        >
          收藏 <ActionKbd action="favorite" />
        </Button>
        <Button
          size="sm"
          className={binary === -1 ? "is-on is-reject" : undefined}
          disabled={busy}
          aria-label="拒绝"
          aria-pressed={binary === -1}
          onClick={() => onRate("binary", -1)}
        >
          拒绝 <ActionKbd action="reject" />
        </Button>
        <Button size="sm" disabled={busy} aria-label="清除" onClick={onClear}>
          清除 <ActionKbd action="clear-rating" />
        </Button>
      </div>
      <div className="inspector-stars" role="group" aria-label={star === null ? "未评星" : `${star} 星`}>
        {STAR_VALUES.map((value) => {
          const filled = star !== null && value <= star;
          return (
            <Button
              variant="icon"
              size="sm"
              key={value}
              className={filled ? "inspector-star is-filled" : "inspector-star"}
              disabled={busy}
              aria-label={`评 ${value} 星`}
              aria-pressed={filled}
              onClick={() => onRate("star", value)}
            >
              <Icon name="star" filled={filled} />
            </Button>
          );
        })}
      </div>
    </div>
  );
}

export function EmptyInspectorNote() {
  return (
    <div className="inspector-empty-note">
      <strong>从左侧媒体池选一条素材</strong>
      <p>评级、标签、章节归属与技术检查都会显示在这里。</p>
    </div>
  );
}
