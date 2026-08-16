/**
 * Timetable axis interactions — PLAN.md §3.
 *
 * The axis is a plain absolutely-positioned track, not a grid of cells: a
 * block's `top`/`height` are computed from `placement.start`/`minutes` in
 * pixels-per-minute, and dragging just writes new pixel values back through
 * the same conversion. Same pointer-events approach as the kanban board
 * (src/lib/board.ts) — an 8px movement threshold before a gesture commits,
 * so a plain tap or a scroll doesn't get mistaken for a drag.
 */

export interface AxisConfig {
  /** Minutes-since-midnight the track's `top: 0` represents. */
  startMinute: number;
  pxPerMinute: number;
}

const THRESHOLD = 8;
const DAY_MAX = 1439;

export const clampMinute = (m: number): number => Math.max(0, Math.min(DAY_MAX, m));

export function snapMinutes(m: number, grid: number): number {
  return clampMinute(Math.round(m / grid) * grid);
}

export function yToMinutes(clientY: number, track: HTMLElement, config: AxisConfig): number {
  const rect = track.getBoundingClientRect();
  return clampMinute(config.startMinute + (clientY - rect.top) / config.pxPerMinute);
}

export function minutesToY(minute: number, config: AxisConfig): number {
  return (minute - config.startMinute) * config.pxPerMinute;
}

/**
 * Drag an already-placed block to a new time. `onRetime` fires once, on
 * release, with the final snapped minute — nothing is written mid-drag.
 */
export function attachBlockDrag(
  track: HTMLElement,
  config: AxisConfig,
  grid: number,
  onRetime: (id: string, start: number) => void,
): void {
  let pending: { pointerId: number; startY: number; block: HTMLElement; id: string } | null = null;
  let dragging: { pointerId: number; block: HTMLElement; id: string; grabOffsetY: number } | null = null;

  track.addEventListener('pointerdown', (e: PointerEvent) => {
    const handle = (e.target as HTMLElement).closest('.block__move') as HTMLElement | null;
    if (!handle) return;
    const block = handle.closest('.block') as HTMLElement | null;
    const id = block?.dataset.id;
    if (!block || !id) return;
    e.stopPropagation(); // don't let the track's tap-to-create fire too
    pending = { pointerId: e.pointerId, startY: e.clientY, block, id };
  });

  track.addEventListener('pointermove', (e: PointerEvent) => {
    if (dragging && e.pointerId === dragging.pointerId) {
      dragging.block.style.top = `${e.clientY - track.getBoundingClientRect().top - dragging.grabOffsetY}px`;
      return;
    }
    if (!pending || e.pointerId !== pending.pointerId) return;
    if (Math.abs(e.clientY - pending.startY) < THRESHOLD) return;

    try {
      pending.block.setPointerCapture(pending.pointerId);
    } catch {
      pending = null;
      return;
    }
    pending.block.classList.add('block--dragging');
    const rect = pending.block.getBoundingClientRect();
    dragging = {
      pointerId: pending.pointerId,
      block: pending.block,
      id: pending.id,
      grabOffsetY: pending.startY - rect.top,
    };
    pending = null;
  });

  const end = (e: PointerEvent) => {
    if (dragging && e.pointerId === dragging.pointerId) {
      const top = parseFloat(dragging.block.style.top || '0');
      const start = snapMinutes(config.startMinute + top / config.pxPerMinute, grid);
      dragging.block.classList.remove('block--dragging');
      onRetime(dragging.id, start);
      dragging = null;
      return;
    }
    if (pending && e.pointerId === pending.pointerId) pending = null;
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
}

/** Drag the bottom-edge handle to change a block's duration. */
export function attachResize(
  track: HTMLElement,
  config: AxisConfig,
  grid: number,
  minMinutes: number,
  onResize: (id: string, minutes: number) => void,
): void {
  let pending: { pointerId: number; startY: number; block: HTMLElement; id: string } | null = null;
  // The block's top edge is fixed during a resize — only the bottom moves —
  // so height is just "how far below the (unmoving) top is the pointer now."
  let active: { pointerId: number; block: HTMLElement; id: string; topY: number } | null = null;

  track.addEventListener('pointerdown', (e: PointerEvent) => {
    const handle = (e.target as HTMLElement).closest('.block__resize') as HTMLElement | null;
    if (!handle) return;
    const block = handle.closest('.block') as HTMLElement | null;
    const id = block?.dataset.id;
    if (!block || !id) return;
    e.stopPropagation();
    pending = { pointerId: e.pointerId, startY: e.clientY, block, id };
  });

  track.addEventListener('pointermove', (e: PointerEvent) => {
    if (active && e.pointerId === active.pointerId) {
      active.block.style.height = `${Math.max(8, e.clientY - active.topY)}px`;
      return;
    }
    if (!pending || e.pointerId !== pending.pointerId) return;
    if (Math.abs(e.clientY - pending.startY) < THRESHOLD) return;

    try {
      pending.block.setPointerCapture(pending.pointerId);
    } catch {
      pending = null;
      return;
    }
    pending.block.classList.add('block--resizing');
    active = {
      pointerId: pending.pointerId,
      block: pending.block,
      id: pending.id,
      topY: pending.block.getBoundingClientRect().top,
    };
    pending = null;
  });

  const end = (e: PointerEvent) => {
    if (active && e.pointerId === active.pointerId) {
      const height = active.block.getBoundingClientRect().height;
      const minutes = Math.max(minMinutes, snapMinutes(height / config.pxPerMinute, grid));
      active.block.classList.remove('block--resizing');
      onResize(active.id, minutes);
      active = null;
      return;
    }
    if (pending && e.pointerId === pending.pointerId) pending = null;
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
}

/** Tap empty track space (not an existing block) to create a card there. */
export function attachTapToCreate(track: HTMLElement, config: AxisConfig, grid: number, onCreate: (start: number) => void): void {
  track.addEventListener('click', (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('.block')) return;
    const minute = snapMinutes(yToMinutes(e.clientY, track, config), grid);
    onCreate(minute);
  });
}
