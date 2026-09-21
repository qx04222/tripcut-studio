import { useEffect, useRef, useState, type ReactNode } from "react";
import { startDuel, type DuelSession } from "../../api";
import { useClipsFeed } from "../useClipsFeed";
import { showToast } from "../ui/Toast";
import { DuelView } from "./DuelView";
import { OPEN_DUEL, resolveDuel, type DuelRequest } from "./duelEntry";

/** Replaces the monitor contents while active: never mounts two mpv owners. */
export function DuelHost({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<DuelSession | null>(null);
  const feed = useClipsFeed();
  const generation = useRef(0);
  const busy = useRef(false);
  useEffect(() => {
    let live = true;
    const open = (event: Event) => {
      if (busy.current) return;
      busy.current = true;
      const token = generation.current + 1;
      generation.current = token;
      const current = () => live && generation.current === token;
      void (async () => {
        try {
          const { members, source } = await resolveDuel((event as CustomEvent<DuelRequest>).detail ?? {});
          if (!current()) return;
          const next = await startDuel(members, source);
          if (!current()) return;
          setSession(next);
        } catch (cause) {
          if (current()) showToast(String(cause), { tone: "danger" });
        } finally {
          if (generation.current === token) busy.current = false;
        }
      })();
    };
    window.addEventListener(OPEN_DUEL, open);
    return () => { live = false; generation.current += 1; busy.current = false; window.removeEventListener(OPEN_DUEL, open); };
  }, []);
  useEffect(() => {
    generation.current += 1;
    busy.current = false;
    setSession(null);
  }, [feed.episode.activeId, feed.episode.viewing]);
  return session ? <DuelView key={session.id} initial={session} clips={feed.clips} onClose={() => setSession(null)} /> : children;
}
