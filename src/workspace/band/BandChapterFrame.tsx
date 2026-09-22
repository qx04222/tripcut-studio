import { createContext, useContext, type ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { chapterDragKey } from "./dragGeometry";

type Sortable = ReturnType<typeof useSortable>;
const Context = createContext<Pick<Sortable, "listeners" | "setActivatorNodeRef"> | null>(null);
export const useChapterDragHandle = () => useContext(Context);
export function BandChapterFrame({ id, disabled, children }: { id: number | null; disabled: boolean; children: ReactNode }) {
  const { setNodeRef, setActivatorNodeRef, transform, transition, listeners, isDragging } = useSortable({ id: chapterDragKey(id), disabled: disabled || id === null });
  return <div ref={setNodeRef} className="band-chapter-frame" data-chapter-key={chapterDragKey(id)} data-dragging={isDragging}
    style={{ transform: CSS.Transform.toString(transform), transition: transition ? "transform var(--motion-fast)" : undefined }}>
    <Context value={{ listeners, setActivatorNodeRef }}>{children}</Context>
  </div>;
}
