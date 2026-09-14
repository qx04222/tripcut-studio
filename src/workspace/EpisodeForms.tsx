import { useState, type JSX } from "react";

import type { CanvasOrientation, TargetPlatform } from "../api";
import { ORIENTATION_LABELS, PLATFORM_LABELS } from "../EpisodePanel";
import { Button, Chip, Field, Select } from "./ui";
import { ORIENTATION_LABEL } from "./copy";

/**
 * 「重命名本集」表单的新壳版(R10 U-32):套件 Field / Select / Chip / Button,不再是系统默认
 * 样式的 fieldset / radio / 裸按钮。AX 名与旧表单一字不差(集标题 / 集主题 / 目标平台 /
 * 画布方向 / 保存 / 取消),冒烟脚本按它们找控件。业务状态仍由 EpisodeSwitcher 持有。
 */
export function WorkspaceEpisodeRenameForm({
  busy,
  draftTitle,
  draftTheme,
  draftPlatform,
  draftOrientation,
  onTitleChange,
  onThemeChange,
  onPlatformChange,
  onOrientationChange,
  onSave,
  onCancel,
}: {
  busy: boolean;
  draftTitle: string;
  draftTheme: string;
  draftPlatform: TargetPlatform;
  draftOrientation: CanvasOrientation;
  onTitleChange: (value: string) => void;
  onThemeChange: (value: string) => void;
  onPlatformChange: (value: TargetPlatform) => void;
  onOrientationChange: (value: CanvasOrientation) => void;
  onSave: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <form
      className="workspace-episode-edit"
      aria-label="重命名本集"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onSave();
      }}
    >
      <Field label="集标题" htmlFor="workspace-episode-title" inline={false}>
        <input
          id="workspace-episode-title"
          className="workspace-episode-input"
          aria-label="集标题"
          value={draftTitle}
          maxLength={120}
          disabled={busy}
          onChange={(event) => onTitleChange(event.currentTarget.value)}
        />
      </Field>
      <Field label="集主题" htmlFor="workspace-episode-theme" inline={false}>
        <input
          id="workspace-episode-theme"
          className="workspace-episode-input"
          aria-label="集主题"
          value={draftTheme}
          maxLength={240}
          placeholder="主题(可留空)"
          disabled={busy}
          onChange={(event) => onThemeChange(event.currentTarget.value)}
        />
      </Field>
      <Field label="目标平台" htmlFor="workspace-episode-platform">
        <Select
          id="workspace-episode-platform"
          aria-label="目标平台"
          value={draftPlatform}
          disabled={busy}
          onChange={(event) => onPlatformChange(event.currentTarget.value as TargetPlatform)}
        >
          {(Object.keys(PLATFORM_LABELS) as TargetPlatform[]).map((platform) => (
            <option key={platform} value={platform}>
              {PLATFORM_LABELS[platform]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={ORIENTATION_LABEL}>
        <div className="workspace-episode-orientation" role="group" aria-label={ORIENTATION_LABEL}>
          {(Object.keys(ORIENTATION_LABELS) as CanvasOrientation[]).map((orientation) => (
            <Chip
              key={orientation}
              selected={draftOrientation === orientation}
              disabled={busy}
              onClick={() => onOrientationChange(orientation)}
            >
              {ORIENTATION_LABELS[orientation]}
            </Chip>
          ))}
        </div>
      </Field>
      <div className="workspace-episode-edit-actions">
        <Button variant="primary" size="sm" type="submit" disabled={busy} busy={busy}>
          保存
        </Button>
        <Button size="sm" disabled={busy} onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}

/**
 * 「新建集」表单(R10 U-16):只要一个名字。当前集有素材 → 后端封存当前集并开新集;
 * 当前集为空 → 就地改名复用(id 不变)。两种结果的提示由 EpisodeSwitcher 负责。
 */
export function WorkspaceEpisodeCreateForm({
  busy,
  onCreate,
  onCancel,
}: {
  busy: boolean;
  onCreate: (title: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [title, setTitle] = useState("");
  const trimmed = title.trim();
  return (
    <form
      className="workspace-episode-edit"
      aria-label="新建集"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && trimmed) onCreate(trimmed);
      }}
    >
      <Field label="新集标题" htmlFor="workspace-episode-new-title" inline={false}>
        <input
          id="workspace-episode-new-title"
          className="workspace-episode-input"
          aria-label="新集标题"
          value={title}
          maxLength={120}
          placeholder="例如:京都三日"
          disabled={busy}
          onChange={(event) => setTitle(event.currentTarget.value)}
        />
      </Field>
      <p className="workspace-episode-edit-help">当前集有素材时会先封存它再开新集(平台与画面方向沿用);当前集还是空的就直接改名。</p>
      <div className="workspace-episode-edit-actions">
        <Button variant="primary" size="sm" type="submit" disabled={busy || trimmed.length === 0} busy={busy}>
          创建
        </Button>
        <Button size="sm" disabled={busy} onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}
