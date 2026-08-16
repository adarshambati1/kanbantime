/**
 * Drag-and-drop for the board, driven by pointer events rather than the
 * HTML5 Drag and Drop API — HTML5 DnD's touch support is inconsistent
 * enough on mobile Safari to be a bad fit for a PWA whose whole reason for
 * existing is working well on a phone. See PLAN.md §2.1.
 *
 * Cards are draggable only from a dedicated handle (`.card__handle`), never
 * from an arbitrary point on the card body, so a normal vertical swipe over
 * the card always scrolls the page. The handle itself distinguishes an
 * intended drag from a scroll-that-happens-to-start-on-the-handle by an 8px
 * movement threshold (PLAN.md §2.2) rather than a press-and-hold delay — no
 * `touch-action` override is applied until that threshold is crossed, so the
 * browser's native scroll can still win right up to that point.
 */

export interface DropResult {
  id: string;
  column: string;
  /** Neighbouring ranks (not ids) — what `rankBetween` actually consumes. */
  before: string | null;
  after: string | null;
}

const THRESHOLD = 8;

interface PendingDrag {
  pointerId: number;
  startX: number;
  startY: number;
  card: HTMLElement;
  id: string;
}

interface ActiveDrag {
  pointerId: number;
  card: HTMLElement;
  id: string;
  placeholder: HTMLLIElement;
  offsetX: number;
  offsetY: number;
}

/**
 * Wires drag handling for every `.card__handle` inside `root`, delegated
 * from a single listener so cards can be re-rendered freely without
 * re-attaching anything. `onDrop` fires once, on release, with the final
 * resting neighbours — nothing is written mid-drag.
 */
export function attachDrag(root: HTMLElement, onDrop: (result: DropResult) => void): void {
  let pending: PendingDrag | null = null;
  let active: ActiveDrag | null = null;

  root.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const handle = (e.target as HTMLElement).closest('.card__handle') as HTMLElement | null;
    if (!handle) return;
    const card = handle.closest('.card') as HTMLElement | null;
    const id = card?.dataset.id;
    if (!card || !id) return;

    pending = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, card, id };
  });

  root.addEventListener('pointermove', (e: PointerEvent) => {
    if (active && e.pointerId === active.pointerId) {
      dragMove(active, e);
      return;
    }
    if (!pending || e.pointerId !== pending.pointerId) return;

    const dx = e.clientX - pending.startX;
    const dy = e.clientY - pending.startY;
    if (Math.hypot(dx, dy) < THRESHOLD) return;

    // commitDrag() can fail (setPointerCapture has real-world failure modes,
    // not just this app's synthetic-event testing) — either way, `pending`
    // must clear here, or a failed commit keeps retrying (and re-throwing)
    // on every subsequent pointermove instead of just not dragging.
    active = commitDrag(pending, e);
    pending = null;
  });

  const end = (e: PointerEvent) => {
    if (active && e.pointerId === active.pointerId) {
      finishDrag(active, onDrop);
      active = null;
      return;
    }
    if (pending && e.pointerId === pending.pointerId) pending = null;
  };

  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
}

function commitDrag(pending: PendingDrag, e: PointerEvent): ActiveDrag | null {
  const { card } = pending;
  const rect = card.getBoundingClientRect();
  try {
    card.setPointerCapture(pending.pointerId);
  } catch {
    // No active pointer session to capture (a real, if rare, failure mode —
    // not just a synthetic-event artifact). Fail closed: no drag, no stuck
    // state, the gesture is simply a no-op rather than a broken retry loop.
    return null;
  }
  card.classList.add('card--dragging');
  card.style.touchAction = 'none';
  card.style.width = `${rect.width}px`;
  card.style.position = 'fixed';
  card.style.left = `${rect.left}px`;
  card.style.top = `${rect.top}px`;
  card.style.zIndex = '50';
  card.style.pointerEvents = 'none';

  const placeholder = document.createElement('li');
  placeholder.className = 'card card--placeholder';
  placeholder.style.height = `${rect.height}px`;
  card.after(placeholder);

  const active: ActiveDrag = {
    pointerId: pending.pointerId,
    card,
    id: pending.id,
    placeholder,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
  };
  dragMove(active, e);
  return active;
}

function dragMove(active: ActiveDrag, e: PointerEvent): void {
  active.card.style.left = `${e.clientX - active.offsetX}px`;
  active.card.style.top = `${e.clientY - active.offsetY}px`;

  active.card.style.visibility = 'hidden';
  const below = document.elementFromPoint(e.clientX, e.clientY);
  active.card.style.visibility = '';

  const list = below?.closest('.column__list') as HTMLElement | null;
  if (!list) return;

  const siblings = [...list.querySelectorAll<HTMLElement>('.card:not(.card--dragging)')].filter(
    (el) => el !== active.placeholder,
  );
  const insertBefore = siblings.find((sib) => {
    const r = sib.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  });

  if (insertBefore) {
    if (active.placeholder.nextElementSibling !== insertBefore) list.insertBefore(active.placeholder, insertBefore);
  } else if (active.placeholder.parentElement !== list || list.lastElementChild !== active.placeholder) {
    list.append(active.placeholder);
  }
}

function finishDrag(active: ActiveDrag, onDrop: (result: DropResult) => void): void {
  const list = active.placeholder.parentElement as HTMLElement | null;
  const column = list?.dataset.column;

  active.card.classList.remove('card--dragging');
  active.card.style.cssText = '';

  if (list && column) {
    // Neighbours' *ranks*, not ids — rankBetween() needs the sort key, and
    // reading it straight off the DOM avoids a second lookup against
    // whatever list the caller last rendered from.
    const before = (active.placeholder.previousElementSibling as HTMLElement | null)?.dataset.rank ?? null;
    const after = (active.placeholder.nextElementSibling as HTMLElement | null)?.dataset.rank ?? null;
    onDrop({ id: active.id, column, before, after });
  }

  active.placeholder.remove();
}
