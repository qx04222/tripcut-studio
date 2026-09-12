import { useCallback, useEffect, useRef, useState } from "react";

import { listSimilarGroups, setSimilarPrimary, type ClipListItem, type SimilarGroup } from "./api";

export function SimilarGroupsPanel({
  clipId,
  readOnly,
  clipsById,
  onCountChange,
}: {
  clipId: number | null;
  readOnly: boolean;
  clipsById: ReadonlyMap<number, ClipListItem>;
  /** R8 Task 5 补丁:相似组一旦从后端拿到就上报当前素材所属的组数(0 或 1),加载完成前不上报。 */
  onCountChange?: (count: number) => void;
}) {
  const [groups, setGroups] = useState<SimilarGroup[]>([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [busyClipId, setBusyClipId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    const seq = ++latest.current;
    listSimilarGroups()
      .then((result) => {
        if (seq !== latest.current || !mounted.current) return;
        setGroups(result);
        setGroupsLoaded(true);
      })
      .catch((loadError) => {
        if (seq !== latest.current || !mounted.current) return;
        setError(`相似组未载入：${String(loadError)}`);
      });
  }, []);

  useEffect(() => refresh(), [refresh]);

  const group = clipId === null ? undefined : groups.find((candidate) =>
    candidate.members.some((member) => member.clip_id === clipId));
  const groupCount = group ? 1 : 0;

  useEffect(() => {
    if (!groupsLoaded) return;
    onCountChange?.(groupCount);
  }, [groupsLoaded, groupCount, onCountChange]);

  const onSetPrimary = (memberClipId: number) => {
    if (readOnly || !group) return;
    setBusyClipId(memberClipId);
    setSimilarPrimary(group.id, memberClipId)
      .then(() => {
        if (!mounted.current) return;
        refresh();
      })
      .catch((setError_) => {
        if (!mounted.current) return;
        setError(`设为主镜头失败：${String(setError_)}`);
      })
      .finally(() => {
        if (mounted.current) setBusyClipId(null);
      });
  };

  return (
    <div className="inspector-section inspector-similar-groups">
      <span>相似镜头</span>
      {readOnly ? <p className="read-only-notice">历史集为只读档案；回到当前集才能切换主镜头</p> : null}
      {error ? <p className="inspector-error">{error}</p> : null}
      {!group ? (
        <p>无相似组</p>
      ) : (
        <ul>
          {group.members.map((member) => {
            const memberClip = clipsById.get(member.clip_id);
            return (
              <li
                key={member.clip_id}
                className={`similar-group-member${member.is_primary ? " primary" : ""}${member.clip_id === clipId ? " selected" : ""}`}
              >
                <span className="similar-group-member-image">
                  {memberClip?.cover_url ? (
                    <img src={memberClip.cover_url} alt="" />
                  ) : (
                    <span>等待封面</span>
                  )}
                </span>
                <strong title={memberClip?.file_name}>{memberClip?.file_name ?? `Clip ${member.clip_id}`}</strong>
                {member.is_primary ? <small className="primary-badge">主镜头</small> : null}
                <button
                  type="button"
                  disabled={readOnly || member.is_primary || busyClipId === member.clip_id}
                  onClick={() => onSetPrimary(member.clip_id)}
                >
                  {busyClipId === member.clip_id ? "设置中…" : "设为主镜头"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
