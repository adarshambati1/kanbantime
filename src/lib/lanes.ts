/**
 * Lane assignment for overlapping timetable blocks — PLAN.md §3.
 *
 * "Split width by overlap count" is wrong for transitive overlaps: A
 * overlapping B and B overlapping C doesn't mean A overlaps C, so a shared
 * count either over-splits or lets non-overlapping cards collide visually.
 * This groups cards into connected components by interval overlap via a
 * sweep, then greedily assigns each card the first lane within its
 * component whose current occupant has already ended.
 *
 * Intervals are half-open `[start, start + minutes)` — a card ending
 * exactly when another starts does not count as overlapping and may reuse
 * its lane.
 */

export interface Interval {
  id: string;
  start: number;
  minutes: number;
}

export interface LaneAssignment {
  id: string;
  /** 0-indexed lane within this card's connected component. */
  lane: number;
  /** Total lanes needed by this card's connected component. */
  lanes: number;
}

const overlaps = (a: Interval, b: Interval): boolean =>
  a.start < b.start + b.minutes && b.start < a.start + a.minutes;

export function assignLanes(intervals: readonly Interval[]): LaneAssignment[] {
  // Stable order: start time, then id as a tie-break so identical-start
  // cards don't jitter lane assignment across re-renders.
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));

  // Sweep left to right, merging components whenever a new interval
  // overlaps one or more currently-open ones.
  const componentOf = new Map<string, number>();
  let nextComponent = 0;
  const open: Interval[] = [];

  for (const iv of sorted) {
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i]!.start + open[i]!.minutes <= iv.start) open.splice(i, 1);
    }
    const touching = new Set(open.filter((o) => overlaps(o, iv)).map((o) => componentOf.get(o.id)!));
    if (touching.size === 0) {
      componentOf.set(iv.id, nextComponent++);
    } else {
      const target = Math.min(...touching);
      componentOf.set(iv.id, target);
      for (const [id, component] of componentOf) {
        if (touching.has(component)) componentOf.set(id, target);
      }
    }
    open.push(iv);
  }

  const groups = new Map<number, Interval[]>();
  for (const iv of sorted) {
    const component = componentOf.get(iv.id)!;
    const list = groups.get(component);
    if (list) list.push(iv);
    else groups.set(component, [iv]);
  }

  const laneOf = new Map<string, number>();
  const laneCountOf = new Map<number, number>();
  for (const [component, group] of groups) {
    const laneEnds: number[] = [];
    for (const iv of group) {
      let lane = laneEnds.findIndex((end) => end <= iv.start);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(iv.start + iv.minutes);
      } else {
        laneEnds[lane] = iv.start + iv.minutes;
      }
      laneOf.set(iv.id, lane);
    }
    laneCountOf.set(component, laneEnds.length);
  }

  return sorted.map((iv) => ({
    id: iv.id,
    lane: laneOf.get(iv.id)!,
    lanes: laneCountOf.get(componentOf.get(iv.id)!)!,
  }));
}
