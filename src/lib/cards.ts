import { rankBetween } from './rank';

/**
 * The one place `placement` gets constructed for a move/retime gesture,
 * shared between the client store (src/lib/store.ts) and, later, the server
 * agent route — so both stay identical to PLAN.md §1.3's transition table
 * without duplicating it, and neither can bypass it into writing `column`,
 * `rank`, and `start` as independent patches (the bug `placement`-as-one-
 * field exists to close — see src/lib/db.ts's module docstring).
 *
 * Pure: no I/O, no environment dependency, so it's trivially the same code
 * on the client and the server.
 */

export interface Placement {
  column: string;
  rank: string;
  start: number | null;
}

export interface MoveInput {
  column: string;
  kind: 'kanban' | 'timetable';
  /** Reorder neighbours. Omit both to leave `rank` unchanged — e.g. a
   *  retime that doesn't also reposition within the tray/column. */
  before?: string | null;
  after?: string | null;
  /** Timetable placement. Omit (or leave undefined) to land in — or stay
   *  in — the unscheduled tray. Only meaningful when `kind` is 'timetable';
   *  a kanban destination always clears `start`. */
  start?: number | null;
}

export function buildPlacement(current: Placement, move: MoveInput): Placement {
  const rank =
    move.before !== undefined || move.after !== undefined
      ? rankBetween(move.before ?? null, move.after ?? null)
      : current.rank;
  const start = move.kind === 'timetable' ? (move.start ?? null) : null;
  return { column: move.column, rank, start };
}
