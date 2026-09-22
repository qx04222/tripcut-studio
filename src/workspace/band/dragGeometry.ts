import type { CollisionDetection, Modifier } from "@dnd-kit/core";
export const CHAPTER_DRAG_PREFIX = "band-chapter:";
export const chapterDragKey = (id: number | null) => `${CHAPTER_DRAG_PREFIX}${id ?? "none"}`;

/** Rectangles come from dnd-kit; no DOM layout reads in the pointer hot path. */
export function bandCollision(alt: () => boolean): CollisionDetection {
  return ({ active, droppableContainers, droppableRects, pointerCoordinates, collisionRect }) => {
    const chapter = String(active.id).startsWith(CHAPTER_DRAG_PREFIX);
    const point = pointerCoordinates ?? { x: collisionRect.left + collisionRect.width / 2, y: collisionRect.top + collisionRect.height / 2 };
    const hits = droppableContainers.flatMap(container => {
      const id = String(container.id), rect = droppableRects.get(container.id);
      if (!rect || container.disabled || id === String(active.id) || (chapter && !id.startsWith(CHAPTER_DRAG_PREFIX))) return [];
      const inside = point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
      if (alt() && !inside) return [];
      if (!inside && (point.y < rect.top - 24 || point.y > rect.bottom + 24)) return [];
      const dx = point.x < rect.left ? rect.left - point.x : point.x > rect.right ? point.x - rect.right : 0;
      // Prefer a concrete segment over its enclosing chapter; empty/folded chapters still receive drops.
      const priority = !chapter && id.startsWith(CHAPTER_DRAG_PREFIX) ? 10000 : 0;
      return [{ id: container.id, data: { droppableContainer: container, value: priority + dx + Math.abs(point.x - rect.left - rect.width / 2) / 1000 } }];
    });
    return hits.sort((a, b) => a.data.value - b.data.value).slice(0, 1);
  };
}

export function magneticBand(alt: () => boolean): Modifier {
  return ({ transform, draggingNodeRect, over }) => {
    if (alt() || !draggingNodeRect || !over) return transform;
    const movingLeft = draggingNodeRect.left + transform.x, movingRight = draggingNodeRect.right + transform.x;
    const distances = [over.rect.left - movingLeft, over.rect.right - movingRight, over.rect.left - movingRight, over.rect.right - movingLeft];
    const snap = distances.reduce((best, value) => Math.abs(value) < Math.abs(best) ? value : best);
    return Math.abs(snap) <= 12 ? { ...transform, x: transform.x + snap } : transform;
  };
}
