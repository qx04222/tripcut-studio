import { useCallback, useEffect, useRef, useState, type JSX } from "react";

import { deleteDisplayLut, deleteWhisperModel, listDisplayLuts } from "../../api";
import { failureText } from "../errorText";
import { Button } from "../ui";
import { SettingsRow } from "./SettingsControls";

/**
 * R16 P2-6:设置 › 工具与模型 里两处「删文件」。删文件不可逆 → 行内确认一次(不弹原生对话框),
 * 删后刷新列表 / 重新检测。
 */

function fileNameOf(path: string): string {
  return path.split("/").pop() ?? path;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** 预览调色文件(`luts/*.cube`)小列表,每条「删除」。 */
export function LutFilesRow(): JSX.Element {
  const [luts, setLuts] = useState<string[]>([]);
  const [arming, setArming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const refresh = useCallback(() => {
    Promise.resolve()
      .then(() => listDisplayLuts())
      .then((paths) => {
        if (mounted.current) setLuts(paths ?? []);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    mounted.current = true;
    refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const onDelete = (name: string) => {
    setBusy(true);
    setNotice(null);
    deleteDisplayLut(name)
      .then((next) => {
        if (!mounted.current) return;
        setLuts(next);
        setNotice(`已删除 ${name};用过它的素材恢复成不调色。`);
      })
      .catch((error) => {
        if (mounted.current) setNotice(failureText("删除调色文件", error));
      })
      .finally(() => {
        if (mounted.current) {
          setBusy(false);
          setArming(null);
        }
      });
  };

  return (
    <SettingsRow title="预览调色文件" help="检查器里可选的 .cube 调色文件;只影响预览,不影响导出。删除不可恢复。" className="settings-sheet-row--stack">
      {luts.length === 0 ? (
        <p className="settings-sheet-inline-notice">还没有调色文件;在检查器「声音与调色」里可以添加。</p>
      ) : (
        <ul className="settings-lut-list" aria-label="预览调色文件">
          {luts.map((path) => {
            const name = fileNameOf(path);
            const armed = arming === name;
            return (
              <li key={path} className="settings-lut-row">
                <span className="settings-lut-name" title={path}>{name}</span>
                {armed ? (
                  <>
                    <span className="settings-lut-confirm">删了就找不回来。</span>
                    <Button size="sm" tone="danger" disabled={busy} aria-label={`确定删除 ${name}`} onClick={() => onDelete(name)}>
                      确定删除
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setArming(null)}>
                      保留
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" disabled={busy} aria-label={`删除 ${name}`} onClick={() => setArming(name)}>
                    删除…
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {notice ? (
        <p className="settings-sheet-inline-notice" role="status">
          {notice}
        </p>
      ) : null}
    </SettingsRow>
  );
}

/** 转写模型「删除已导入的模型文件…」:当前档;删后重新检测(模型缺失卡会自动出现)。 */
export function WhisperModelDelete({ tier, busy, onDeleted }: { tier: string; busy: boolean; onDeleted(): Promise<void> }): JSX.Element {
  const [armed, setArmed] = useState(false);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onDelete = () => {
    setWorking(true);
    setNotice(null);
    deleteWhisperModel(tier)
      .then(async (freed) => {
        await onDeleted().catch(() => undefined);
        if (mounted.current) setNotice(`已删除 ${tier} 模型文件,腾出 ${formatBytes(freed)}。需要转写时再导入。`);
      })
      .catch((error) => {
        if (mounted.current) setNotice(failureText("删除模型文件", error));
      })
      .finally(() => {
        if (mounted.current) {
          setWorking(false);
          setArmed(false);
        }
      });
  };

  return (
    <div className="settings-model-delete">
      {armed ? (
        <>
          <span className="settings-lut-confirm">删了就找不回来,要再转写得重新导入。</span>
          <Button size="sm" tone="danger" busy={working} disabled={busy} aria-label={`确定删除 ${tier} 模型文件`} onClick={onDelete}>
            确定删除
          </Button>
          <Button size="sm" variant="ghost" disabled={busy || working} onClick={() => setArmed(false)}>
            保留
          </Button>
        </>
      ) : (
        <Button size="sm" variant="ghost" disabled={busy} aria-label="删除已导入的模型文件" onClick={() => setArmed(true)}>
          删除已导入的模型文件…
        </Button>
      )}
      {notice ? (
        <p className="settings-sheet-inline-notice" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
