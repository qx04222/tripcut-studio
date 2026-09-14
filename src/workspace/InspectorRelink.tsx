import { useEffect, useRef, useState, type JSX } from "react";

import { pickRelinkFile, relinkClip } from "../api";
import { failureText } from "./errorText";
import { Button } from "./ui";
import { refreshClipsFeed } from "./useClipsFeed";

/**
 * R16 P1-7:检查器头部的「找到它…」——原片不在原位(`missing_since`)时,与缺失页每条
 * 同一个入口:文件面板选同名文件 → `relink_clip`(后端校验同名 + 时长 ±0.5 s)→ 刷新素材表。
 * 不在缺失态时渲染 null,头部一字不动。
 */
export function InspectorRelink({ clipId, fileName, missing }: { clipId: number; fileName: string; missing: boolean }): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => setNotice(null), [clipId]);
  if (!missing) return null;

  const onFind = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const path = await pickRelinkFile(fileName);
      if (!path) return;
      await relinkClip(clipId, path);
      await refreshClipsFeed(true).catch(() => undefined);
      if (mounted.current) setNotice("已找到,分析结果与评分都还在。");
    } catch (error) {
      if (mounted.current) setNotice(failureText("找到它", error, "请选同名、同一段视频的那个文件"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <div className="inspector-relink" role="group" aria-label="原片不在原来的位置">
      <span className="inspector-relink-text">原片不在原来的位置(可能拔了卡或移了文件夹)。</span>
      <Button size="sm" icon="search" busy={busy} aria-label={`找到 ${fileName}`} onClick={() => void onFind()}>
        找到它…
      </Button>
      {notice ? (
        <p className="inspector-notice" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
