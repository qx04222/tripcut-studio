import { useCallback, useEffect, useRef, useState, type JSX } from "react";

import { deleteSelectSegment, listSelectSegments, playerCommand, type SelectSegment } from "../api";
import { ExportSelectedButton } from "./deliver/QuickExportEntry";
import { Button, Icon } from "./ui";
import { refreshClipsFeed } from "./useClipsFeed";
import { failureText } from "./errorText";

/**
 * 检查器「精选段」区(R10 U-11):「保存片段」之后片段在界面上得看得见、能复播、能删。
 * 列表按 `select_count` 变化重取(监视器保存后 feed 会带着新的计数回来);复播 = 让共享的
 * mpv 实例 seek 到入点再播(监视器与检查器看的是同一个播放器);删除走既有的
 * `delete_select_segment`(软删,后端留 restore)。
 */

/** 与 `bandDurationLabel` 同一套 mm:ss.mmm 语义的短格式:入出点用秒 + 一位小数就够读了。 */
export function segmentSecondsLabel(ticks: number, tbNum: number, tbDen: number): string {
  if (tbDen <= 0 || tbNum <= 0) return "0.0s";
  const seconds = (ticks * tbNum) / tbDen;
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = seconds - minutes * 60;
  return minutes > 0 ? `${minutes}:${rest.toFixed(1).padStart(4, "0")}` : `${rest.toFixed(1)}s`;
}

export function segmentSeconds(ticks: number, tbNum: number, tbDen: number): number {
  return tbDen <= 0 || tbNum <= 0 ? 0 : (ticks * tbNum) / tbDen;
}

export const SEGMENT_AUTOFAVORITE_HINT = "「保存片段」会自动收藏整条素材（故事板只认收藏或有精选段的素材）";

export function SelectSegmentsSection({
  clipId,
  selectCount,
  readOnly,
}: {
  clipId: number;
  /** feed 里这条素材的精选段计数:它一变就重取列表(保存 / 删除都会动它)。 */
  selectCount: number;
  readOnly: boolean;
}): JSX.Element {
  const [segments, setSegments] = useState<SelectSegment[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const mounted = useRef(true);
  const latest = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(() => {
    const seq = ++latest.current;
    listSelectSegments(clipId)
      .then((result) => {
        if (seq !== latest.current || !mounted.current) return;
        setSegments(result);
      })
      .catch((error) => {
        if (seq !== latest.current || !mounted.current) return;
        setSegments([]);
        setNotice(failureText("读取精选段", error));
      });
  }, [clipId]);

  useEffect(() => {
    setNotice(null);
    reload();
  }, [reload, selectCount]);

  const replay = useCallback(
    async (segment: SelectSegment) => {
      const inSeconds = segmentSeconds(segment.in_ticks, segment.tb_num, segment.tb_den);
      try {
        await playerCommand({ type: "seek_abs", seconds: inSeconds });
        await playerCommand({ type: "play" });
        setNotice(null);
      } catch (error) {
        setNotice(failureText("复播", error));
      }
    },
    [],
  );

  const remove = useCallback(
    async (segment: SelectSegment) => {
      setBusyId(segment.id);
      try {
        await deleteSelectSegment(segment.id);
        setNotice("已删除精选段");
        await refreshClipsFeed(true);
        reload();
      } catch (error) {
        setNotice(failureText("删除精选段", error));
      } finally {
        if (mounted.current) setBusyId(null);
      }
    },
    [reload],
  );

  return (
    <div className="inspector-segments">
      {segments === null ? (
        <p className="inspector-segments-empty">正在读取精选段…</p>
      ) : segments.length === 0 ? (
        <p className="inspector-segments-empty">还没有精选段。在监视器用 I / O 打入出点后按「保存片段」。</p>
      ) : (
        <ul className="inspector-segment-list" aria-label="精选段列表">
          {segments.map((segment, index) => {
            const inLabel = segmentSecondsLabel(segment.in_ticks, segment.tb_num, segment.tb_den);
            const outLabel = segmentSecondsLabel(segment.out_ticks, segment.tb_num, segment.tb_den);
            const durationLabel = segmentSecondsLabel(segment.out_ticks - segment.in_ticks, segment.tb_num, segment.tb_den);
            return (
              <li key={segment.id} className="inspector-segment-row">
                <span className="inspector-segment-index">{`段 ${index + 1}`}</span>
                <span className="inspector-segment-range">{`${inLabel} → ${outLabel}`}</span>
                <span className="inspector-segment-duration">{durationLabel}</span>
                <span className="inspector-segment-actions">
                  <Button variant="icon" size="sm" icon="play" aria-label={`复播精选段 ${index + 1}`} title="从入点播放" onClick={() => void replay(segment)} />
                  <Button
                    variant="icon"
                    size="sm"
                    icon="x"
                    tone="danger"
                    aria-label={`删除精选段 ${index + 1}`}
                    title="删除这段精选"
                    disabled={readOnly || busyId === segment.id}
                    onClick={() => void remove(segment)}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="inspector-segments-hint">
        <Icon name="info" size={12} />
        {SEGMENT_AUTOFAVORITE_HINT}
      </p>
      {/* R11 车道 E:只把这条素材的精选段快速导出(交给交付抽屉的快速模式)。 */}
      {segments && segments.length > 0 ? <ExportSelectedButton segmentIds={segments.map((segment) => segment.id)} /> : null}
      {notice ? (
        <p className="inspector-notice" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
