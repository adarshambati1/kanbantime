/**
 * Fractional ranking.
 *
 * Cards are ordered by a short string sorted lexicographically, and inserting
 * between two neighbours means finding a string that sorts between them. The
 * point is that a reorder touches exactly one row.
 *
 * That matters because conflict resolution in this app is per-field
 * last-write-wins. With integer positions, dragging one card renumbers every
 * card below it — a dozen writes for one gesture, each of which can collide
 * with a different device's view of the same list. With a fractional rank the
 * drag is one field on one row, and two devices reordering different cards
 * merge cleanly instead of fighting.
 *
 * Known characteristic: repeatedly inserting into the *same* gap grows the
 * string by about a character each time — drop 300 cards between the same two
 * neighbours and you get a 300-character rank. That's inherent to the scheme
 * and harmless in practice, because real reordering spreads out. If a column
 * ever does degenerate, re-seeding it with initialRanks() resets the lengths.
 */

/** Digits, in ASCII order, so string comparison matches numeric order. */
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const FIRST = DIGITS[0]!;
const LAST = DIGITS[DIGITS.length - 1]!;
const MID = DIGITS[Math.floor(DIGITS.length / 2)]!;

const value = (ch: string): number => {
  const i = DIGITS.indexOf(ch);
  return i < 0 ? 0 : i;
};

/**
 * A rank strictly between `before` and `after`.
 *
 * Pass null for either end to append or prepend. Both null gives a midpoint
 * suitable for the first card in an empty column.
 */
export function rankBetween(before: string | null, after: string | null): string {
  // An empty column seeds mid-space rather than at the bottom. Starting at '1'
  // leaves no headroom below it, so the first prepend has to extend the string
  // and every prepend after that extends it again.
  if (before === null && after === null) return MID;

  const lo = before ?? '';
  const hi = after ?? '';

  if (lo && hi && lo >= hi) {
    throw new Error(`rankBetween: "${lo}" is not before "${hi}"`);
  }

  let prefix = '';
  let i = 0;

  // Walk the shared prefix; the first position where they differ is where
  // there's room to insert.
  for (;;) {
    const a = lo[i] ?? FIRST;
    const b = hi[i] ?? undefined;

    if (b === undefined) {
      // Open-ended above: step past `lo` and we're done.
      if (a === LAST) {
        // No headroom at this digit, so carry and keep walking.
        prefix += a;
        i++;
        continue;
      }
      const next = DIGITS[value(a) + 1]!;
      // Landing exactly on `lo`'s next digit is fine as long as lo ends here.
      return prefix + (lo.length > i + 1 ? a + MID : next);
    }

    if (a === b) {
      prefix += a;
      i++;
      continue;
    }

    const gap = value(b) - value(a);
    if (gap > 1) return prefix + DIGITS[value(a) + Math.floor(gap / 2)]!;

    // Adjacent digits: keep `lo`'s digit and go deeper on the next position.
    prefix += a;
    i++;
    const tail = lo.slice(i);
    return prefix + rankBetween(tail, null);
  }
}

/** Evenly spread ranks for seeding a column. */
export function initialRanks(count: number): string[] {
  const out: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < count; i++) {
    prev = rankBetween(prev, null);
    out.push(prev);
  }
  return out;
}
