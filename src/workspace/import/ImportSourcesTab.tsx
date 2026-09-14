import type { JSX } from "react";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { Icon } from "../ui/icons";
import { SectionHeader } from "../ui/SectionHeader";
import { Toggle } from "../ui/Toggle";
import { openSettings } from "../openSettings";
import { formatSyncTime, splitPathForEllipsis } from "./importModel";
import { ImportRecentCard } from "./ImportRecentCard";
import type { ImportSources } from "./useImportSources";

/** 路径中间省略:头段 CSS 尾部省略、末段不收缩(样式在 shell-r10.css)。AX 名仍是整条路径。 */
function EllipsisPath({ path, className }: { path: string; className?: string }): JSX.Element {
  const { head, tail } = splitPathForEllipsis(path);
  return (
    <span className={`import-path import-path--middle${className ? ` ${className}` : ""}`} title={path} aria-label={path}>
      <span className="import-path-head" aria-hidden="true">{head}</span>
      {tail ? <span className="import-path-tail" aria-hidden="true">{tail}</span> : null}
    </span>
  );
}

/** 「添加素材文件夹」的三态文案:面板开着 = 选择中;选完在扫 = 扫描中(U-07)。 */
function addFolderLabel(choosing: boolean, scanning: boolean): string {
  if (choosing) return "选择中…";
  if (scanning) return "扫描中…";
  return "添加素材文件夹";
}

/** 来源分页(规格 §4.1):说明 + 添加文件夹;关注文件夹卡;工具链警告;一行结果。 */
export function ImportSourcesTab({ sources }: { sources: ImportSources }): JSX.Element {
  const { watched, notice, error, choosing, scanning, dragActive, toolchainMissing, folder } = sources;
  const busy = choosing || scanning;

  return (
    <div className="import-tab import-sources">
      <section className="import-section" aria-label="素材来源">
        <SectionHeader
          title="素材来源"
          description="只登记素材位置,不复制或改写原片"
          actions={
            <Button variant="primary" icon="plus" busy={busy} onClick={() => void sources.chooseFolder()}>
              {addFolderLabel(choosing, scanning)}
            </Button>
          }
        />
        {folder ? (
          <p className="import-sources-hint">
            最近添加 <EllipsisPath path={folder} />
          </p>
        ) : null}
        {toolchainMissing ? (
          <Card className="import-toolchain" role="alert">
            <Icon name="warning" size={20} className="import-toolchain-icon" />
            <div className="import-toolchain-copy">
              <p>应用内置的媒体工具不可用，暂时无法解析画面与时长。请重新安装完整 DMG；开发调试时也可到设置页「工具链」填写可信的自定义路径。</p>
              <Button size="sm" onClick={() => openSettings("tools")}>
                去设置
              </Button>
            </div>
          </Card>
        ) : null}
      </section>

      <section className="import-section" aria-label="已关注的素材文件夹">
        <SectionHeader
          title="已关注的文件夹"
          meta={watched.length > 0 ? `${watched.length} 个` : undefined}
          description="子文件夹名会自动成为素材分类;开启自动同步后每 5 分钟增量检查新素材(适合网络硬盘 / 云盘)"
          actions={
            <Button size="sm" onClick={() => void sources.rescan()}>
              立即扫描
            </Button>
          }
        />
        {watched.length > 0 ? (
          <ul className="import-watched">
            {watched.map((item) => (
              <Card as="li" key={item.id} className="import-watched-row">
                <div className="import-watched-copy">
                  <strong className="import-watched-path">
                    <EllipsisPath path={item.path} />
                  </strong>
                  <small>{formatSyncTime(item.last_scan_at)}</small>
                </div>
                <label className="import-watched-sync" htmlFor={`watched-sync-${item.id}`}>
                  自动同步
                </label>
                <Toggle
                  id={`watched-sync-${item.id}`}
                  label="自动同步"
                  checked={item.auto_sync}
                  onChange={(next) => void sources.setAutoSync(item.id, next)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon="x"
                  title="仅取消关注,已导入素材不受影响"
                  onClick={() => void sources.remove(item.id)}
                >
                  移除
                </Button>
              </Card>
            ))}
          </ul>
        ) : (
          <Card className="import-watched-empty">
            <EmptyState
              size="inline"
              icon="import"
              title="还没有关注的文件夹"
              body="点右上角「添加素材文件夹」,或把文件夹拖到下面的虚线框里。"
            />
          </Card>
        )}
      </section>

      <section className="import-section" aria-label="拖放导入">
        <Card className={`import-dropzone${dragActive ? " import-dropzone--active" : ""}`}>
          <Icon name="import" size={32} className="import-dropzone-icon" />
          <div className="import-dropzone-copy">
            <strong>把文件夹拖到这里</strong>
            <span>或点击选择相机卡 / 移动硬盘 / 本地文件夹;只登记位置,原片不动</span>
          </div>
          <Button icon="plus" busy={busy} onClick={() => void sources.chooseFolder()}>
            选择文件夹
          </Button>
        </Card>
      </section>

      <div className="import-status" aria-live="polite">
        {error ? (
          <p className="import-note import-note--error" role="alert">
            {error}
          </p>
        ) : null}
        {!error && notice ? (
          <p className="import-note" role="status">
            {notice}
          </p>
        ) : null}
      </div>

      <ImportRecentCard refreshKey={notice} />
    </div>
  );
}
