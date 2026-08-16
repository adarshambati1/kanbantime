# Kanban Time — Board, Timetable, Agent

Implementation plan for the three items in the README's "Still to build" list.
Written against the code as it exists today: `src/lib/db.ts`, `src/lib/rank.ts`,
`src/lib/store.ts`, `src/pages/index.astro` (currently a flat checklist, not a
board), `scripts/smoke.sh`.

Status: **plan only, nothing below is implemented yet.** Revision 3. Revision
2 folded in a first Codex review's findings (migration path, cross-kind
moves, column-deletion orphaning, prefs merge granularity, an inaccurate
agent-code-reuse claim), each marked `[codex]`. A second Codex pass on
revision 2 found the central fix was still incomplete — independently
merging `column`/`rank`/`start` as three separate LWW fields can't actually
prevent an incoherent post-merge card no matter how atomically the *client*
composes the write, because the *server* merge is the real boundary and it
still resolves each field on its own timestamp. That forced an architecture
change (§1.2/§1.5, now unified into one `placement` field), plus several
smaller closes. Those are marked `[codex r2]`.

---

## 0. Scope and non-negotiables

- Stay local-first: every mutation, including the agent's, goes through a
  shared, environment-neutral command/validation layer that both the client
  store and the server route call — not literally the same functions, since
  `store.ts`'s functions are IndexedDB-only and can't run in an API route.
  See §4.1.
- Stay field-level LWW — but choose field *boundaries* to match what's
  actually one user gesture, the same reasoning `rank.ts` already used to
  justify a fractional index over per-position writes. `[codex r2]` A reorder
  is one field because a drag is one gesture; by the same logic, "where and
  when this card sits" (column + order + scheduled time) is now one field
  too (§1.2), because a move/retime is one gesture and independently-merged
  sub-fields can recombine into a state nobody actually wrote.
- No new resource (prefs) gets whole-blob LWW where field-level was the
  point. See §1.4.
- One person, one deployment. No multi-tenant concerns, no permissions model
  beyond "signed in or not."
- Reuse `rankBetween`/`rank.ts` wherever order matters.

---

## 1. Data model changes

Current `Todo` (`src/lib/db.ts`, `src/lib/store.ts`, mirrored in both):
`id, title, notes, done, due, deleted, column, rank, minutes, ts, seq`.

### 1.1 `placement`: one field, not three

**`[codex r2]` This is the central change in this revision.** Revisions 1–2
both tried to keep `column`, `rank`, and `start` as independent `FIELDS`
entries and make the *client* write them together atomically (`moveCard()`).
The second Codex review constructed the concrete failure this can't prevent:

> Card is in a timetable column. Device A drags it to Backlog, writing
> `{column, rank}` at t=100. Device B, offline, independently retimes it on
> the timetable at t=200 (later), writing `{start}` only. Both eventually
> sync. Server `merge()` resolves each field on its own timestamp: `column`/
> `rank` come from A (t=100, and B never touched them so B's copy still has
> the old values — but per-field LWW compares whichever is newer per field,
> and B's `start` at t=200 is newer than A's `start`, which A's write didn't
> even touch). Result: `{column: 'backlog', start: 600}` — a kanban card
> silently carrying a stale timetable time that reappears the moment it's
> dragged back to a timetable column.

No amount of client-side atomicity fixes this, because the server never sees
"this was one gesture" — it only sees three field timestamps. The fix has to
be at the same boundary as the bug: **collapse `column`, `rank`, and `start`
into one field, `placement`, with one timestamp.**

```ts
interface Placement {
  column: string;
  /** Fractional rank — meaningful only when the column's kind is 'kanban'
   *  or for a card sitting in a timetable column's unscheduled tray. */
  rank: string;
  /** Minutes since local midnight, or null — meaningful only when the
   *  column's kind is 'timetable' and the card has been placed on the axis. */
  start: number | null;
}
```

Stored as one JSON-encoded TEXT column (`placement`), the same pattern the
table already uses for `ts`. `FIELDS` becomes `['title', 'notes', 'done',
'due', 'deleted', 'placement', 'minutes']` — seven entries, not nine. One
`ts.placement` timestamp. A move, a reorder, and a retime are all "write a
new `Placement` value" — different construction, same one field, same one
merge decision. Whichever device's placement write is newer wins *as a
whole*, which is what actually happened in the physical world (you either
moved the card, or you didn't — there's no such thing as "half moved it").

**Tradeoff, stated plainly:** if two devices make two different placement
edits concurrently (say, one reorders within Backlog while the other,
independently and for some reason, also touches the same card's placement),
only one survives — full LWW, no partial merge. That's a real loss of
generality compared to per-field merge, but it's the correct one: those two
edits are competing claims about "where does this card go," not
independently-mergeable data, so picking a winner is the right behavior, not
a limitation to work around.

`minutes` (duration) stays a separate field — resizing a block changes how
long it takes, not where or when it starts, and can legitimately be edited
from a detail view with no placement change involved.

**Query-path note.** The existing SQL index `idx_todos_col ON todos(col,
rank)` depended on `column`/`rank` being plain columns. With `placement`
opaque JSON, keep a **derived, non-authoritative shadow column** `col TEXT`
for indexing only — written to whatever `Placement.column` says every time
`placement` is written, in the same statement, so it can never drift out of
sync (it's not independently timestamped or merged, it's a same-transaction
mirror, the same way a computed column would be if libSQL had one natively).
Board reads for a single column still get an index; nothing about it
participates in conflict resolution.

### 1.2 Migration, validation, and the ingestion boundary

**`[codex]` Migration.** `db()` today only runs `CREATE TABLE IF NOT
EXISTS`, which does nothing to a table that already exists without
`placement`. Real migration, idempotent and column-existence-checked:

```ts
async function migrate(c: Client): Promise<void> {
  const cols = await c.execute(`PRAGMA table_info(todos)`);
  const have = new Set((cols.rows as unknown as Row[]).map((r) => String(r.name)));
  if (!have.has('placement')) {
    try {
      await c.execute(
        `ALTER TABLE todos ADD COLUMN placement TEXT NOT NULL DEFAULT '{"column":"backlog","rank":"m","start":null}'`,
      );
      await c.execute(`ALTER TABLE todos ADD COLUMN col TEXT NOT NULL DEFAULT 'backlog'`);
      // Backfill the two legacy columns into the new shape for existing rows,
      // then the old `column`/`rank` columns become dead weight — drop them in
      // a follow-up release once the backfill has run in production, not in
      // the same migration (SQLite's ALTER TABLE DROP COLUMN support and
      // libSQL's compatibility with it should be verified before relying on
      // it in the same step as the write that populates the replacement).
      await c.execute(
        `UPDATE todos SET placement = json_object('column', col_legacy, 'rank', rank_legacy, 'start', NULL), col = col_legacy
         FROM (SELECT id, col AS col_legacy, rank AS rank_legacy FROM todos) AS legacy
         WHERE todos.id = legacy.id`,
      );
    } catch (err) {
      // `[codex r2]` Concurrent cold starts can both pass the PRAGMA check
      // and race on ALTER TABLE — the loser's ALTER fails with "duplicate
      // column name", which is expected and safe to swallow. Any other error
      // is real and should still throw.
      if (!String(err).includes('duplicate column name')) throw err;
    }
  }
}
```

(Exact SQL above is illustrative — the actual migration needs to run against
the *current* production schema, which still has separate `col`/`rank`
columns and no `start` at all, so the real implementation backfills from
those, not from a hypothetical prior `start` column. The important
properties are: idempotent, concurrency-safe via the swallow-and-check
pattern, and never destructive to existing data before the backfill is
verified.)

**`[codex r2]` Normalize at ingestion, not just at the base/local side.** The
first review round's fix (`base.start ?? null`) only normalized the
*existing* side before merge; an incoming payload from a not-yet-updated
client missing the field entirely could still let `undefined` win. Fixed
differently now that `placement` is one field: every incoming row is
normalized to a well-formed `Placement` **once, at the top of `push()`,
before merge ever runs** — `incoming.placement ??= { column: 'backlog',
rank: rankAfterLast('backlog'), start: null }` (and equivalent handling if a
row has a `placement` object with missing sub-keys). One normalization point
for the whole ingestion path, not a per-field patch scattered across call
sites.

**`[codex r2]` Server-side placement validation, on every write path.**
Round 2 flagged that `push()` today accepts any `column` string with no
validation, and that this isn't just a `set_columns`-time concern — `/api/sync`
and `quickAdd()` are both direct write paths that bypass any higher-level
command layer. Fix: `push()` itself validates and, where needed, repairs
every incoming `placement` before it's persisted, unconditionally, regardless
of `deleted` status (so a tombstoned card's placement is corrected the same
as a live one's — closing the resurrection edge case in §1.4):

- `start` must be `null` or an integer in `[0, 1439]`; otherwise clamp/null it.
- `rank` must be a non-empty string; otherwise regenerate via `rankBetween`.
- `column` must be a currently-valid, non-retired column id (§1.4). If it
  isn't — a stale client referencing a removed column, a resurrected
  tombstone whose old column no longer exists, a malformed agent call — the
  row is **not rejected** (rejecting would break the sync protocol's
  always-accept-and-merge guarantee that offline resilience depends on); it's
  silently remapped to a fallback column (the first column in `prefs.columns`
  order, e.g. `backlog`), the same clamp-don't-reject treatment `minutes`
  already gets today (`Math.max(5, ...)`).
- `minutes` gets a **maximum** added next to its existing minimum: `Math.min(720,
  Math.max(5, Math.round(Number(row.minutes) || 30)))` — nothing in the
  current code bounds it above, so an unbounded value (typo, bad agent call)
  could otherwise produce a timetable block that dominates or breaks the
  axis layout (§3).

### 1.3 Cross-kind transitions, expressed as `Placement` construction

With one field, a transition is just "what `Placement` value does this
gesture produce," not a multi-field coordination problem:

- kanban → kanban (reorder/move column): `{column: target, rank:
  rankBetween(before, after), start: null}`.
- kanban → timetable: `{column: target, rank: <unchanged, kept in case it's
  later moved to another kanban column>, start: null}` — lands in the
  unscheduled tray; placing it on the axis is a separate, explicit
  drag/gesture, hence a separate placement write.
- timetable → kanban: `{column: target, rank: rankBetween(before, after),
  start: null}` — `start` is always cleared on the way out, so it can't
  silently reappear if the card is later moved back into a timetable column.
- timetable → timetable (retime/resize within or across timetable columns):
  `{column: target-or-same, rank: <unchanged>, start: newStart}`.

Every transition is one `Placement` object, one write, one timestamp — the
incoherent-recombination bug in §1.1 is closed structurally, not by
convention, because there's no longer a way to write "just the column" or
"just the start" through the normal path. (§4.1 covers the one remaining way
a client *could* still bypass this — a generic patch tool — and closes it by
scoping the allowlist.)

### 1.4 Columns: immutable, permanently-retired ids, and race-safe removal

```ts
// src/lib/columns.ts
export interface ColumnDef {
  id: string;
  label: string;
  kind: 'kanban' | 'timetable';
}

export const DEFAULT_COLUMNS: ColumnDef[] = [
  { id: 'backlog', label: 'Backlog', kind: 'kanban' },
  { id: 'doing',   label: 'Doing',   kind: 'kanban' },
  { id: 'done',    label: 'Done',    kind: 'kanban' },
  { id: 'today',   label: 'Today',  kind: 'timetable' },
];
```

Column definitions are themselves editable state (§4, "change what the
frontend looks like"). Round 1 flagged silent orphaning (remove/rename an id
out from under referencing cards → invisible, not deleted); round 2 found
the round-2 fix still had three gaps:

- **`[codex r2]` Tombstones weren't covered.** `remove()` only flips
  `deleted`; a card's `placement.column` survives deletion, and `deleted` is
  an ordinary LWW field that can be un-set later by an older write racing in
  — so a column could be removed while only tombstoned cards reference it,
  and a later resurrection would bring back a card pointing at a column that
  no longer exists. **Closed by §1.2's unconditional validation**: since
  `push()` now validates/remaps `placement.column` on every incoming row
  regardless of `deleted`, a resurrected card either still has a valid
  column or gets silently remapped to the fallback — it can never come back
  invisible.
- **`[codex r2]` Id reuse wasn't actually prevented.** "Immutable once
  created" didn't stop a *retired* id from being reused later for an
  unrelated new column. Fix: retired ids are kept in a permanent list —
  `prefs['columns.retired']`, a JSON array, itself one more per-key prefs
  row (§1.5) — and `set_columns` rejects any incoming column whose id
  appears there, forever, not just at the moment of removal.
- **`[codex r2]` Check-then-write was a race.** A card could be
  created/moved into the target column between a separate "is this column
  empty" check and the removal write. Fix: the whole operation — count
  non-deleted cards referencing the column, and if zero, write the new
  columns list plus append to the retired-ids list — happens inside **one
  database transaction** (the same `c.transaction('write')` pattern
  `push()` already uses), so nothing can interleave between the check and
  the write. If the count is nonzero, the transaction is abandoned and the
  request is rejected with the blocking count, same as before.

Remaining invariant, unchanged from round 2: at least one column must always
exist; a column's `kind` can't change while non-deleted cards reference it
(same transactional check as removal).

### 1.5 Prefs: a separate endpoint, per-key rows, local dirty-tracking

Unchanged in substance from revision 2, one addition:

- Separate endpoint, `/api/prefs`, session-cookie-gated, independent of the
  todo sync cursor.
- One row **per individual preference**, keyed by a dotted path (`columns`,
  `columns.retired`, `ui.accent`, `ui.density`, ...), each with its own `ts`,
  merged by plain `incoming.ts >= existing.ts` — field-level LWW applied at
  row granularity instead of column granularity, same rule either way.
- **`[codex r2]` Client-side dirty-tracking, matching `store.ts`'s existing
  pattern.** Round 2 noted the plan defined the server shape but not a local
  write-then-sync story. Mirrors `roundTrip()` almost exactly: a local
  `prefs` IndexedDB store, writes set a `dirty` flag, a sync pass sends dirty
  rows, clears the flag unless the row was touched again mid-flight (the
  same `sent`-map-plus-timestamp-comparison approach `store.ts` already
  uses for todos) — no new synchronization idea needed, just the existing
  one applied to a second, smaller resource.

---

## 2. Board UI

Replaces the current flat list in `src/pages/index.astro`. New structure:

- `src/pages/index.astro` — page shell, reads `prefs['columns']`, renders one
  `<section class="column">` per `ColumnDef`, `kind: 'kanban'` ones get a
  plain vertical card stack, `kind: 'timetable'` ones render via the
  timetable layout (§3).
- `src/lib/board.ts` (new, client) — drag orchestration.
- `src/lib/cards.ts` (new, isomorphic command layer) — `addCard`,
  `moveCard` (§1.3's transition table — the **only** way `placement` gets
  written), `updateCard`, `deleteCard`, `setColumns` (§1.4's invariants).
  Callable from both `store.ts` (client, wraps with the IndexedDB write) and
  the agent route (server, wraps with the server `push()` call) — this is
  the actual shared surface, replacing revision 1's inaccurate claim that
  the agent reuses `store.ts`'s (IndexedDB-only) functions directly.
  **`[codex r2]` `updateCard`'s field allowlist explicitly excludes
  `placement`.** Round 2 found that even with `moveCard()` centralized,
  a generic `update_card`-style patch tool could still write `placement`
  directly and bypass the transition table entirely, reopening the exact bug
  §1.1 exists to close. `placement` is only ever constructed by `moveCard()`;
  no other function in `cards.ts` accepts it as a patch key.

### 2.1 Drag-and-drop

Pointer events (`pointerdown`/`pointermove`/`pointerup`), not the HTML5 Drag
and Drop API — inconsistent touch support on mobile Safari is a bad fit for
a PWA whose whole reason for existing is working well on a phone. Manual
hit-testing (`elementFromPoint` against sibling midpoints),
`setPointerCapture` so a fast finger move during a scroll doesn't drop the
drag.

Sequence on drop: compute the neighbour pair the card landed between, call
`cards.moveCard()` with the right `Placement` per §1.3, re-render
optimistically from IndexedDB immediately, `sync()` in the background — same
pattern `index.astro` already uses for check/delete today.

### 2.2 `[codex ux]` Interaction design

A Codex review role-playing a week of actual daily use (laptop + PWA) found
the plan through §1–§4 (revision 2) was backend-first: every mutation had a
command, but the actual on-screen interactions a person needs were either
missing or only implied. Its verdict was that the plan needed "an explicit
interaction/UI pass before implementation." These are that pass — the
highest-signal findings, each with the fix adopted:

- **No card-creation affordance was specified anywhere.** `addCard` existed
  as a command-layer function, not a described on-screen control. **Fix:**
  every kanban column gets a persistent "Add card" affordance (reusing the
  existing `.add`/`.add__field`/`.add__btn` pattern already in
  `index.astro` — extended to take a target column instead of always
  `backlog`), plus the existing global quick-add stays as the fast path for
  "just capture this," landing in a configurable default column
  (`prefs['ui.quickAddColumn']`, defaulting to `backlog`).
- **No way to create a card at a specific time.** The only described
  timetable-placement route was drag-an-existing-tray-card-onto-the-axis.
  **Fix:** add a tap/click-on-an-empty-slot → create-card-at-that-time flow
  as the primary phone-friendly route; drag-from-tray remains available as a
  secondary route for a card that already exists elsewhere.
- **Drag vs. scroll arbitration was entirely unspecified** for touch — §2.1
  named the pointer-event mechanism but never said how a vertical finger
  drag is told apart from a page/column scroll, and flagged no threshold or
  handle. This is a genuine daily-use blocker on a phone, not a nitpick.
  **Fix:** cards are **not** draggable from an arbitrary point on their
  body — a small drag handle (visually a hover/focus-revealed affordance,
  consistent with §7's design constraints, not a permanent grip icon) is the
  only drag-initiation target, so a normal vertical swipe on the card body
  always scrolls regardless of anything else. **`[codex ux]`** The
  activation rule for the handle itself, picked concretely rather than left
  as an either/or: `pointerdown` on the handle starts a *pending* drag with
  no `touch-action` override yet — the browser's native scroll can still win.
  Only once `pointermove` exceeds an 8px distance from the `pointerdown`
  origin does the interaction commit to a drag (`setPointerCapture`,
  `touch-action: none` from that point on); below 8px, a `pointerup` is
  treated as a tap/no-op, not a drag. No time-based delay — a distance
  threshold reads as more responsive on touch than a press-and-hold delay,
  and 8px is small enough to feel immediate while still absorbing normal
  finger jitter during an intended scroll. The resize handle (§3) is a
  separate, distinct target using the same 8px-threshold rule.
- **15-minute grid was too coarse and inconsistent with the data model** —
  `start` accepts any minute and `minutes` has a server floor of 5, but the
  UI could only place/resize on quarter-hours, so a real 5- or 10-minute
  task couldn't be represented faithfully by dragging. **Fix:** default grid
  drops to 5 minutes (`prefs['ui.snapMinutes']`, user-adjustable to 15 for
  people who want coarser blocks); a card's exact start/duration remains
  directly editable as numbers in the card detail view regardless of
  whatever grid the drag interaction snaps to, so precision is never
  drag-only.
- **Unscheduled tray had no bound.** No stated height, internal scroll,
  count, or collapse behavior — a busy day's tray could push the actual time
  axis off-screen. **Fix:** tray is a fixed-height, independently-scrolling
  region with a collapse toggle, sitting above the axis without displacing
  it further than that fixed height. **`[codex design]`** The toggle and
  count are plain text, not a badge/chip/pill — e.g. `Unscheduled (4)` as a
  text link in `--color-text-subtle`, the same treatment `index.astro`
  already gives secondary text (the status line), not a decorated counter
  element.
- **No responsive/overflow behavior for the board itself.** Four columns,
  one of them a full timetable, don't fit a phone screen simultaneously.
  **Fix:** horizontal scroll-snap between columns on narrow viewports (one
  column filling the viewport at a time, swipe/scroll between them), normal
  multi-column flex layout above a breakpoint (tablet/laptop width).
- **The agent (§4) had no UI surface at all** — a real gap, not a deferred
  detail, per both this review and the design-consistency review reaching
  the same conclusion independently. **Fix:** a single persistent entry
  point (a text input, not a floating chat-bubble widget — consistent with
  §7's restraint) reachable from the board header, expanding to show the
  conversation only while in use rather than occupying permanent screen
  space. **`[codex ux]`** A location wasn't the whole gap — the interaction
  itself needs to be complete enough to predict what happens after typing:
  Enter submits (a plain multiline-capable field with Enter-to-send and
  Shift+Enter for a newline, no separate send button needed on
  laptop/desktop; the PWA's on-screen keyboard return key submits the same
  way, matching how the existing quick-add field already behaves on submit).
  While a response is in flight, the input disables and the conversation
  area shows a plain-text `thinking…` line (reusing the `#status` line's
  existing minimal vocabulary, not a spinner icon). A failed call appends a
  plain-text error line with an inline "retry" text link, not a toast or
  modal. Conversation history is session-only — cleared when the panel
  collapses, not persisted as a long-lived chat log — since this is a
  lightweight command surface, not a chat product; reopening the panel
  starts fresh. **`[codex ux]`** One explicit exception: an outstanding
  proposal (§4.2) is state, not transcript — it's tracked independently of
  whether the panel is open, survives a collapse, and isn't discarded by
  "conversation history clears on collapse." Reopening the panel with a
  pending proposal shows a compact one-line `1 action awaiting review` entry
  that expands back into the same review screen, instead of silently losing
  it; it still disappears the normal way, via §4.2's existing expiry.
- **The confirmation flow (§4.2) had a fully specified backend and zero
  described UI** — no review screen, no visible affected-card list, no
  countdown, no recovery path for an expired proposal. **Fix:** confirming a
  bulky agent action shows the actual `{applied, skipped}`-shape preview
  (before proposing — the same list the server will later reconcile
  against) as a plain list of card titles with their before→after
  column/time, with explicit Confirm/Cancel controls and a visible
  "expires in Ns" — matching, not duplicating, the server-side proposal
  lifecycle in §4.2. **`[codex design]`** Not a modal/dialog overlay — that's
  exactly the kind of chrome §7 rules out. The preview renders inline, as
  part of the same expanding agent-conversation area §2.2 already describes
  (it's the agent's next message, not a separate UI system), and
  Confirm/Cancel reuse the app's one existing button pattern (`.add__btn` in
  `index.astro` — solid, for the primary action; `.foot__signout` in
  `App.astro` — plain underlined text, for the secondary one) rather than
  introducing a new button style. The expiry countdown is
  plain text (`expires in 0:45`), not a progress bar or ring. **`[codex ux]`**
  Two states this still left unhandled: if the countdown reaches zero before
  the user acts, the review list is replaced in place by a plain-text
  "this changed — " with a "ask again" link that resends the original
  request text to the agent rather than requiring it to be retyped; after a
  confirm, the `{applied, skipped}` result renders as one plain-text summary
  line appended to the conversation (`"3 applied, 2 skipped — changed since
  you asked"`), where the skipped count is itself a tap-to-expand text
  toggle (reusing §2.2's tray-toggle pattern) listing which cards and why,
  not a separate screen. **`[codex ux]`** "Ask again" is an ordinary new
  request to the agent, not a raw resend-and-reapply shortcut — it goes
  through the normal §4.1 flow from scratch, which evaluates current board
  state fresh and, per §4.2's own >5-card threshold, produces a **new**
  proposal (with its own review screen) if the request is still bulky. There
  is structurally no path where an expired proposal's stale action list gets
  applied without a new review — "ask again" can only ever lead to another
  confirmation step, never a silent reapplication of outdated intent.
- **Overlapping timetable blocks could become unreadable at narrow lane
  widths** on a phone. **Fix:** below a minimum lane width, collapse the
  overlap group to a single stacked indicator ("3 overlapping") that expands
  to a short list on tap, rather than rendering ever-narrower unreadable
  slivers.
- **No card anatomy was defined** — title only was implied; nothing about
  showing duration, notes-present indicator, or done state at a glance.
  **Fix:** compact card shows title, done-state (matching the existing
  checkbox pattern), and duration when in a timetable context; everything
  else (notes, due date) lives in a tap-through detail view, not on the
  card face — keeping the board itself uncluttered per §7.
- **No offline/sync/conflict feedback, no delete-undo, no empty/error
  states** were specified, despite the README's local-first model already
  implying all of these exist as states the UI passes through. **Fix:**
  reuse and extend the existing `#status` status-line pattern already in
  `index.astro` (`'syncing…'`, `'offline'`, `"couldn't save"`) rather than
  inventing a new status mechanism; add a dismissible Undo affordance after
  delete (a few seconds, client-side only — the tombstone write itself is
  unaffected, Undo just means "don't tombstone yet" if the window hasn't
  closed, or "un-delete" as an ordinary field write if it has); add a
  minimal empty-board first-run state and a legible rejection message for a
  blocked column removal (§1.4), stating the blocking count. **`[codex ux]`**
  "Conflict feedback" named in the original finding turned out to need its
  own answer, not just an offline/syncing status: when a background sync
  pass changes a card's `placement` out from under what's currently rendered
  (another device moved or retimed it since the last render), the card
  briefly gets the same `--color-border-strong` outline §3 already uses for
  an active drag/resize (reused, not a new visual pattern), fading after a
  few seconds, and the `#status` line shows `"updated"` for the same
  duration — enough to notice something changed and which card, without a
  persistent banner or a forced acknowledgment. **`[codex ux]`** That
  outline is only visible if the card is still on the currently-rendered
  column — on the phone's one-column-at-a-time layout (§2.2), a remote move
  can relocate a card to a column that's off-screen, where an unlabeled
  "updated" is meaningless. Fix: the status text names the card and its new
  location (`"‘Write proposal’ moved to Doing"`), and is itself a tap target
  that scroll-snaps the board to that column — so the same mechanism that
  works when the card stays visible degrades gracefully into a navigable
  answer to "wait, where did it go" when it doesn't.

### 2.3 Explicitly out of scope for v1

- No swimlanes, no sub-tasks, no card colors/labels beyond `prefs['ui.*']`.
- No column WIP limits.
- No multi-select drag.

---

## 3. Timetable

The `kind: 'timetable'` column renders as a vertical day axis, reading
`placement.start` directly (no derived rank involved for placed cards):

- Visible range 06:00–22:00 by default (`prefs['ui.timetableRange']`,
  hardcoded for v1) is a **viewport**, not the valid domain — `start`'s
  domain is the full 0–1439, a card can legitimately sit outside the default
  window, and the axis simply scrolls to it rather than clamping or hiding
  it.
- **`[codex design]` Axis composition detail**, closing the last gap from
  the design-consistency review: hour labels at 60-minute cadence only (not
  every 15/30-minute gridline — that's the "dense grid cells" §7 rules out),
  in a narrow label gutter just wide enough for `--text-xs` text, no
  border/background around the gutter itself. Hour rules are a single
  `--color-border` line spanning the card-block width, not the label gutter.
  A card mid-drag or mid-resize indicates its active state with a
  `--color-border-strong` outline (the same token the existing `.add__field`
  border already uses), not a shadow, glow, or selection-highlight fill —
  consistent with §7's no-shadows constraint.
- Each card: `top = (start - axisStart) * pxPerMinute`, `height = minutes *
  pxPerMinute`, clamped to a minimum readable height (e.g. 24px) regardless
  of duration. `minutes` is now server-bounded to `[5, 720]` (§1.2), so the
  layout has a defined worst case.
- **Move**: pointer delta in Y → minutes, rounded to `prefs['ui.snapMinutes']`
  (default 5 — see §2.2's `[codex ux]` note; 15 was found too coarse against
  a data model that allows any minute), writes a new `Placement` with the
  updated `start` via `moveCard()`.
- **Resize** (bottom-edge handle only): adjusts `minutes`, same grid (the
  server's `[5, 720]` clamp is the actual bound; exact values remain directly
  editable in the card detail view regardless of the drag grid).
- Cards with `start === null` render in an "unscheduled" tray above the axis,
  ordered by `placement.rank` — dragging one onto the axis is a
  kanban-tray→timetable-placed transition (§1.3), still one `Placement` write.
- **Overlap: allowed, not prevented** — no server-side scheduling
  transaction exists to make conflict-free placement actually guaranteed
  across offline devices, and silently snapping would override a
  deliberately-chosen time (human or agent's).
- **Lane assignment for overlapping blocks**, replacing revision 1's
  incorrect "split width by overlap count" (wrong for transitive overlaps —
  A–B and B–C overlapping doesn't mean A and C do): standard
  interval-partitioning. Group cards into connected components by overlap
  (half-open interval `[start, start+minutes)`), assign each card the first
  lane within its component whose current occupant has already ended, width
  = `columnWidth / lanesInComponent`. Verified against a 4-card transitive
  chain (A–B, B–C, C–D, A/C and B/D non-overlapping): 2 lanes suffice, C
  reuses A's lane once A ends, D reuses B's once B ends. **`[codex r2]`
  Endpoint semantics**: an interval is half-open, so a card ending exactly
  when another starts does *not* count as overlapping and may reuse its
  lane — needs a test case for exactly this boundary (§5).

---

## 4. Agent

"Full control within reason" of board content, and of the board's own
presentation.

### 4.1 Shape

New endpoint `src/pages/api/agent.ts`, session-cookie-gated only (not the
Shortcuts bearer token). Request: `{ message: string, history?: ... }`.
OpenRouter with tool-calling, a fixed closed set of tools, executed
server-side through `src/lib/cards.ts` (§2) plus the prefs write path.

| Tool | Maps to |
| --- | --- |
| `list_cards(column?)` | read, scoped |
| `add_card(title, column, minutes?, start?)` | `cards.addCard` (constructs a `Placement` via the same transition rules) |
| `move_card(id, column?, before?, after?, start?)` | `cards.moveCard` (§1.3) — the only tool that can change `placement` |
| `update_card(id, patch)` | `cards.updateCard` — `placement` is **not** in its allowlist (§2) |
| `delete_card(id)` | tombstone, not hard delete |
| `list_columns()` / `set_columns(columns)` | `prefs['columns']`, §1.4's invariants incl. permanent id retirement |
| `set_ui_pref(key, value)` | one row in `prefs`, allowlisted key set only |
| `bulk_retime(changes: {id, start?, minutes?, column?}[])` | one `cards.ts` batch call → one server transaction. **`[codex r2]`**: each entry still goes through the *same* `moveCard()` transition construction per card — the batch's atomicity is "N coherent placements land in one transaction," not "N raw field patches," so this can't reopen §1.1 the way an unguarded `column` parameter could have. |

Every write still carries a `ts` map and goes through the same merge
function as any human edit.

### 4.2 Guardrails

- Every agent-originated write's `ts` is stamped with request time like a
  human edit — no separate "agent time."
- Provenance tag (`origin: 'user' | 'agent'`) is cosmetic metadata only, not
  synced/merged. **`[codex design]`** A *persistent* badge on agent-touched
  cards was flagged as inconsistent with this app's own established
  decoration pattern — the existing delete `×` is hover/focus-revealed, not
  always visible (`src/pages/index.astro`'s `.todo__del` opacity rule), and
  a permanent badge is exactly the kind of bolted-on chrome that pattern
  exists to avoid. Fixed: same hover/focus-reveal treatment, not a
  persistent visual element — the provenance is there to inspect if you look
  (hover a card, or check its detail view), not broadcast at all times.
- Rate limit: same shape as the OAuth callback rate-limiting already on the
  README's to-build list.
- **`[codex r2]` Confirmation flow, fully specified.** When a turn would
  delete/move/bulk-retime more than N=5 cards, or touch `set_columns` in a
  way that reassigns any card, the endpoint persists a proposal row
  server-side (not a client-trusted action list):

  ```sql
  CREATE TABLE IF NOT EXISTS agent_proposals (
    id         TEXT PRIMARY KEY,
    actions    TEXT NOT NULL,   -- canonical JSON action list
    status     TEXT NOT NULL DEFAULT 'pending',  -- pending | consumed | expired
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )
  ```

  The client receives only the proposal `id`. Confirming sends the `id`
  alone; the server, in one transaction, checks `status = 'pending' AND now
  < expires_at`, and if so **atomically flips it to `consumed` before
  applying anything** — closing the round-2 replay gap (a proposal is
  single-use; resending the same id after confirmation returns "already
  applied," not a second application). For each action in the stored list,
  the server re-checks its precondition against current state (e.g. the
  target card still exists and is in the state implied by the proposal); an
  action whose precondition no longer holds is **skipped, not applied and
  not treated as a fatal error for the batch** — consistent with the sync
  model's own "always make progress, report deltas" philosophy rather than
  all-or-nothing rejection. The response reports `{applied: [...], skipped:
  [...]}` so the client can tell the user "3 of 5 applied — 2 had changed
  since you asked," rather than silently completing or silently discarding
  the whole batch.

### 4.3 Blocked on

A new OpenRouter API key — the previous one was pasted into this
conversation by accident and has already been revoked; it must not be reused
or reproduced anywhere. Nothing in §4 can be exercised end-to-end until a
fresh key exists in the Vercel env (never in a committed file).

---

## 5. Testing

New cases beyond current `scripts/smoke.sh` coverage, roughly in build order:

1. **Migration**: fresh DB gets `placement` via `CREATE TABLE`; a DB seeded
   with the *current production schema* (`col`/`rank`, no `placement`) gets
   backfilled correctly via `ALTER TABLE` + `UPDATE`, no data loss; two
   concurrent cold starts against the same pre-migration DB both succeed
   (one via the primary path, one via the swallowed "duplicate column"
   race) and end up with identical resulting schema.
2. **Placement round-trip and validation clamps**: out-of-range `start`,
   empty `rank`, and out-of-bounds `minutes` are each corrected rather than
   rejected; a `column` referencing a retired/nonexistent id is remapped to
   the fallback column, not dropped.
3. **All four transition cases** (§1.3): each asserts the *whole*
   `Placement` object post-move, not just that one field changed.
4. **The round-2 failure scenario itself, as a regression test**: reproduce
   the exact concurrent kanban-move-vs-timetable-retime race from §1.1's
   writeup and assert the post-merge card is coherent (either fully A's
   placement or fully B's, by timestamp — never a recombination).
5. **Column lifecycle**: removal blocked while non-deleted cards reference
   it; removal blocked while *only tombstoned* cards reference it (the
   round-2 case) unless/until validated remap logic is confirmed to handle
   resurrection safely; a retired id can never be reused by a later
   `set_columns` call, including after a server restart.
6. **Prefs**: two concurrent writes to different `ui.*` keys both survive;
   same-key concurrent writes resolve by timestamp; local dirty-tracking
   round-trips the same way `store.ts`'s does today.
7. **Agent confirmation flow**: propose → confirm happy path; confirm with
   an expired or unknown proposal id is rejected; confirming the same
   (valid) proposal id twice applies once and reports "already applied" the
   second time; a proposal where one target card changed after proposal
   creation but before confirm applies the rest and reports the skip.
8. **Timetable lane assignment**: the A–B–C–D transitive chain from §3;
   the exact-endpoint-touching boundary case (§3's `[codex r2]` note).
9. **Concurrent retime-vs-unrelated-field edit**: device A retimes
   `placement.start` while device B edits `title` on the same card — both
   survive (this now spans two different fields, `placement` and `title`,
   so it's the ordinary cross-field LWW guarantee, unaffected by collapsing
   column/rank/start into one field).

---

## 6. Rollout order

1. §1 data model, migration, validation, and §5's migration/round-trip/
   regression tests — including the round-2 concurrent-race regression test
   before anything else is built on top of `placement`.
2. §2 board UI (kanban columns only, `today` column temporarily rendered as
   a plain stack). Includes `cards.ts` and the §1.3 transition table, since
   even kanban-only drag needs `moveCard()` and the closed `updateCard`
   allowlist to exist.
3. §3 timetable rendering for the `today` column, plus lane-assignment logic.
4. §4 agent, once a new OpenRouter key exists.

Each step keeps `npm test` (smoke) and `npm run verify` (typecheck + build +
rank property test) green before moving to the next.

---

## 7. `[codex design]` Design constraints

A separate Codex review checked §2–§4 against this app's existing visual
language — `src/styles/index.css`'s actual token set, the sibling copy of
the same file in the site repo, and the restraint already visible in
`App.astro`/`index.astro` (a one-line header, rows separated by nothing more
than a single `--color-border` bottom border, a delete control that only
appears on hover). Its verdict was **high consistency risk as written**:
§2–§4 specified board/timetable/agent *behavior* in real detail but close to
zero *visual* treatment, which is exactly the gap a generic-looking,
panel-heavy SaaS board or calendar widget would fall into by default. One
factual correction from that review, noted for whoever implements this: both
this app's and the site's `index.css` currently define a **light** palette
(`--color-bg: #ffffff`, `color-scheme: light`), not dark — this plan's own
older references to a "dark aesthetic" describe the site's *hero* animation
background specifically, not the shared token set, and shouldn't be taken as
ground truth for the board's palette.

Its core finding, adopted as a rule for implementation:

> A time axis and a resize handle are functional information, not
> decoration — "no chrome" can't mean literally zero structure. The gap
> isn't that structure exists, it's that the plan didn't distinguish
> *functional* structure from *decorative* chrome anywhere. Every element
> needs to earn its place as one or the other.

Concrete constraints for whoever implements §2–§4, adapted from that
review's recommendation:

- Extend the existing token set only — `--font-sans`, existing `--space-*`,
  `--radius-*`, and `--color-*` variables. No new colors, no shadows, no
  gradients, no icon set introduced for this feature.
- Prefer plain text and whitespace over containers. A column is spacing and
  a label, not a boxed panel; a card is a row separated by a single
  `--color-border` line (matching `index.astro`'s existing `li` styling
  today), not a bordered/shadowed card well.
- The timetable axis (§3) — the one place this feature genuinely needs a
  visual addition — is functional structure, shown as quiet `--text-xs`
  `--color-text-subtle` labels and single-pixel `--color-border` hour rules,
  never a shaded/gridded calendar-app look.
- Drag and resize handles, and the agent-provenance indicator (§4.2), follow
  the app's one existing decoration precedent — hover/focus-revealed, never
  permanently visible (`.todo__del`'s `opacity` rule in `index.astro` is the
  literal pattern to reuse, not just the principle).
- The agent's entry point (§2.2) is a text input in the existing visual
  language, not a chat-widget aesthetic import (bubble shadows, avatar
  icons, a floating action button) — it should look like it was always part
  of this board, not bolted on from a different product.
- No status badges, ribbons, or colored labels beyond what's already
  specified (done-state, the hover-only provenance indicator). If a future
  need genuinely requires one, it should read as text with `--color-*`
  tokens, not a pill/chip component.
