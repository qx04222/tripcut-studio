import type { CSSProperties, JSX } from "react";

import type { ModelCard as ModelCardData } from "../../api";
import { cancelModel, installModel } from "../modelStore";
import { Badge, Button, Icon } from "../ui";

/** 「≈1.6 GB」/「≈753 MB」:给人看的体积,十进制(与 Finder 的口径一致)。 */
export function formatModelSize(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    const gb = bytes / 1_000_000_000;
    return `≈${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
  }
  return `≈${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

export function percentOf(downloaded: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.floor((downloaded / total) * 100));
}

/**
 * R19 P-06(models 车道):设置 › 工具与模型 里每个模型一张卡,三态——
 * 「未安装(≈0.75 GB)· 安装」/「下载中 42% · 取消」/「已安装 · 位置」;失败态多一个「重试」。
 * 「安装」与首启气泡走同一个入口(`modelStore.installModel`),进度由后端事件推过来。
 * AX 名:group = 模型标题;按钮 = 「安装 <标题>」「取消下载 <标题>」「重试下载 <标题>」。
 */
export function ModelCard({ card, busy = false }: { card: ModelCardData; busy?: boolean }): JSX.Element {
  const downloading = card.phase === "downloading";
  const percent = percentOf(card.downloaded, card.total);
  const state = card.installed && !downloading ? "installed" : downloading ? "downloading" : card.phase === "error" ? "error" : "idle";

  return (
    <div className="settings-model-card" role="group" aria-label={card.title} data-model-id={card.id} data-model-state={state}>
      <div className="settings-model-card-head">
        <strong>{card.title}</strong>
        {state === "installed" ? (
          <Badge tone="accent" icon="check">已安装</Badge>
        ) : state === "downloading" ? (
          <Badge tone="neutral">下载中 {percent}%</Badge>
        ) : state === "error" ? (
          <Badge tone="danger" icon="warning">下载失败</Badge>
        ) : (
          <Badge tone="neutral">未安装({formatModelSize(card.size_bytes)})</Badge>
        )}
        {card.recommended && state === "idle" ? <Badge tone="warn">推荐</Badge> : null}
      </div>
      <p className="settings-model-card-purpose">{card.purpose}</p>
      {state === "downloading" ? (
        <div className="settings-model-card-progress" aria-hidden="true">
          <span style={{ "--progress": `${percent}%` } as CSSProperties} />
        </div>
      ) : null}
      {state === "installed" ? (
        <code className="settings-model-card-location">{card.location ?? "已安装"}</code>
      ) : null}
      {state === "error" && card.error ? (
        <p className="settings-sheet-inline-notice is-error" role="alert">{card.error}</p>
      ) : null}
      {!card.allowed && card.blocked_reason ? (
        <p className="settings-model-card-blocked">
          <Icon name="info" size={12} />
          {card.blocked_reason}
        </p>
      ) : null}
      <div className="settings-model-card-actions">
        {state === "downloading" ? (
          <Button size="sm" variant="ghost" aria-label={`取消下载 ${card.title}`} onClick={() => void cancelModel(card.id)}>
            取消
          </Button>
        ) : state === "error" ? (
          <Button size="sm" aria-label={`重试下载 ${card.title}`} disabled={busy || !card.allowed} onClick={() => void installModel(card.id)}>
            重试
          </Button>
        ) : state === "idle" ? (
          <Button size="sm" aria-label={`安装 ${card.title}`} disabled={busy || !card.allowed} onClick={() => void installModel(card.id)}>
            安装
          </Button>
        ) : null}
        <small>来源核对于 {card.fetched_on};下载后校验 SHA-256,不对不启用。</small>
      </div>
    </div>
  );
}
