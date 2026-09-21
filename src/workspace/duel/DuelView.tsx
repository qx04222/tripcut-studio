import { useCallback, useEffect, useRef, useState } from "react";
import { duelAction, type ClipListItem, type DuelSession } from "../../api";
import { Button } from "../ui";
import { pushUndo, runUndoById } from "../undoStack";
import { refreshClipsFeed } from "../useClipsFeed";
import { DUEL_PHOTO_ZOOM, DuelPreview } from "./DuelPreview";
import { DUEL_CHANGED, notifySimilarGroupsChanged } from "./duelBus";

export async function refreshDuel(): Promise<void> {
  await refreshClipsFeed(true);
  window.dispatchEvent(new Event(DUEL_CHANGED));
  notifySimilarGroupsChanged();
}
export function DuelView({ initial, clips, onClose }: { initial: DuelSession; clips: readonly ClipListItem[]; onClose(): void }) {
  const [session, setSession] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const lock = useRef(false);
  const undoId = useRef<number | null>(null);
  const undoAll = useCallback(async () => {
    const next = await duelAction(initial.id, "undo_session");
    setSession(next);
    await refreshDuel();
  }, [initial.id]);
  const act = useCallback(async (op: "decide" | "undo_last" | "undo_session" | "finish", winner?: string | null) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      if (op === "undo_session") {
        if (undoId.current !== null) await runUndoById(undoId.current); else await undoAll();
        return;
      }
      let next = op === "decide" ? await duelAction(session.id, op, winner ?? null) : op === "finish" ? session : await duelAction(session.id, op);
      setSession(next);
      if (next.pair.length === 0 && !next.finished) {
        next = await duelAction(next.id, "finish");
        if (undoId.current === null) undoId.current = pushUndo({ label: "撤销擂台", undo: undoAll });
        await refreshDuel();
      }
      setSession(next); setActive(0);
    } catch (cause) { setError(String(cause)); }
    finally { lock.current = false; setBusy(false); }
  }, [session, undoAll]);
  const mixed = session.pair.length === 2 && session.pair[0]!.startsWith("photo:") !== session.pair[1]!.startsWith("photo:");
  const photoPair = session.pair.length === 2 && session.pair.every((key) => key.startsWith("photo:"));
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.isComposing || e.repeat || (e.target instanceof HTMLElement && e.target.closest("input,textarea,[contenteditable=true]"))) return;
      let handled = true;
      if (e.key === "Escape") onClose();
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") void act(session.finished ? "undo_session" : "undo_last");
      else if (!session.finished && !session.undone && e.key === "ArrowLeft" && session.pair[0]) void act("decide", session.pair[0]);
      else if (!session.finished && !session.undone && e.key === "ArrowRight" && session.pair[1]) void act("decide", session.pair[1]);
      else if (!session.finished && e.key === "ArrowUp" && mixed) void act("decide", null);
      else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "z" && photoPair) window.dispatchEvent(new Event(DUEL_PHOTO_ZOOM));
      else if (e.key === " ") setActive((side) => 1 - side);
      else handled = false;
      if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [session, mixed, photoPair, act, onClose]);
  const name = (key: string) => {
    const member = session.members.find((m) => key === (m.segment_id === null ? `photo:${m.clip_id}` : `video:${m.segment_id}`));
    return clips.find((c) => c.id === member?.clip_id)?.file_name ?? key;
  };
  return <section className="duel-r21" aria-label="擂台" aria-busy={busy}>
    <header><strong>擂台</strong><span>{session.finished ? "本组已选好" : `第 ${Math.min(session.round + 1, session.total)}/${session.total} 场`}</span><Button onClick={onClose}>退出擂台</Button></header>
    {session.undone ? <p role="status">已撤销整组擂台</p> : session.finished ? <div className="duel-finish"><h2>保留 {session.winners.length} 条</h2>{session.winners.map((key) => <p key={key}>{name(key)}</p>)}<Button disabled={busy} onClick={() => void act("undo_session")}>整组撤销</Button></div> : <>
      {session.pair.length === 0 ? <Button disabled={busy} onClick={() => void act("finish")}>完成本组</Button> : null}
      <DuelPreview session={session} clips={clips} active={active} onActive={setActive} />
      <footer><Button disabled={busy || !session.pair.length} onClick={() => void act("decide", session.pair[0])}>左边更好</Button><Button disabled={busy || !session.pair.length} onClick={() => void act("decide", session.pair[1])}>右边更好</Button><Button disabled={busy || !mixed} onClick={() => void act("decide", null)}>两个都留</Button><Button disabled={busy || session.round === 0} onClick={() => void act("undo_last")}>撤销上一场</Button></footer>
      <p className="duel-hint">{photoPair ? "← / → 选择 · Z 同步缩放 · 放大后拖动 · ⌘Z 撤销 · Esc 保留进度退出" : "← / → 选择 · ↑ 跨媒体双保留 · 空格切换预览 · ⌘Z 撤销 · Esc 保留进度退出"}</p>
    </>}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
