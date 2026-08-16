import { rankBetween } from './rank';
import { buildPlacement, type MoveInput, type Placement } from './cards';

/**
 * Client-side local-first store.
 *
 * The rule that makes the app feel instant: the UI reads from IndexedDB and
 * never awaits the network. Writes land locally, mark the record dirty, and a
 * background sync reconciles. Offline isn't a mode — it's just sync not having
 * run yet.
 */

export type { Placement } from './cards';

export const FIELDS = ['title', 'notes', 'done', 'due', 'deleted', 'placement', 'minutes'] as const;
export type Field = (typeof FIELDS)[number];

export interface Todo {
  id: string;
  title: string;
  notes: string;
  done: number;
  due: string | null;
  deleted: number;
  placement: Placement;
  /** Planned duration in minutes, for the timetable. */
  minutes: number;
  ts: Partial<Record<Field, number>>;
  /** Local-only: set when this record has unpushed changes. Stripped on send. */
  dirty?: number;
}

const DB_NAME = 'todo';
const STORE = 'todos';
const META = 'meta';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(META)) d.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

const getAll = () => tx<Todo[]>(STORE, 'readonly', (s) => s.getAll());
const getOne = (id: string) => tx<Todo | undefined>(STORE, 'readonly', (s) => s.get(id));
const put = (t: Todo) => tx(STORE, 'readwrite', (s) => s.put(t));
const getMeta = <T>(k: string) => tx<T>(META, 'readonly', (s) => s.get(k));
const setMeta = (k: string, v: unknown) => tx(META, 'readwrite', (s) => s.put(v, k));

/** Visible todos, open first, then by most recent activity. */
export async function list(): Promise<Todo[]> {
  const all = await getAll();
  return all
    .filter((t) => !t.deleted)
    .sort((a, b) => a.done - b.done || stamp(b) - stamp(a));
}

/** Visible todos in one column, ordered by rank (kanban stacking / tray
 *  order) — used by the board, not the flat list. */
export async function listColumn(column: string): Promise<Todo[]> {
  const all = await getAll();
  return all
    .filter((t) => !t.deleted && t.placement.column === column)
    .sort((a, b) => (a.placement.rank < b.placement.rank ? -1 : a.placement.rank > b.placement.rank ? 1 : 0));
}

const stamp = (t: Todo) => Math.max(0, ...Object.values(t.ts ?? {}));

/**
 * `start`/`minutes` let a timetable column create a card directly on the
 * axis (tap-a-slot-to-create, PLAN.md §2.2's primary phone-friendly route)
 * instead of always landing unscheduled in the tray. `rank` is still
 * computed either way — harmless for a placed card, and needed if it's
 * later moved to a kanban column or the tray.
 */
export async function add(
  title: string,
  column = 'backlog',
  start: number | null = null,
  minutes = 30,
): Promise<Todo> {
  const now = Date.now();
  // Append: rank after whatever is currently last in that column.
  const existing = await listColumn(column);
  const last = existing.length > 0 ? existing[existing.length - 1]!.placement.rank : null;

  const t: Todo = {
    id: crypto.randomUUID(),
    title: title.trim(),
    notes: '',
    done: 0,
    due: null,
    deleted: 0,
    placement: { column, rank: rankBetween(last, null), start },
    minutes,
    ts: Object.fromEntries(FIELDS.map((f) => [f, now])) as Todo['ts'],
    dirty: 1,
  };
  await put(t);
  return t;
}

/**
 * Writes any field — not exported. `move()` below is the only caller
 * allowed to pass `placement` (via `allowPlacement`); every other caller
 * goes through the public `update()`, which forbids it both at the type
 * level and here, at runtime.
 *
 * The runtime check is not redundant with `update()`'s type restriction —
 * TypeScript types are erased at runtime and a caller can always defeat a
 * static guard with a type assertion (`as { title: string }`, widening the
 * value's *apparent* type without changing what it actually is at
 * runtime). No type-level trick closes that; only checking the actual
 * object here does. This is what makes "only move() writes placement" true
 * rather than merely "the compiler doesn't warn about it in common cases."
 */
async function patch(
  id: string,
  fields: Partial<Pick<Todo, Field>>,
  allowPlacement = false,
): Promise<void> {
  if (!allowPlacement && 'placement' in fields) {
    throw new Error('update() cannot write placement — use move() instead');
  }
  const existing = await getOne(id);
  if (!existing) return;
  const now = Date.now();
  const ts = { ...existing.ts };
  for (const k of Object.keys(fields) as Field[]) ts[k] = now;
  await put({ ...existing, ...fields, ts, dirty: 1 });
}

/**
 * Move a card — the only place a client writes `placement`. Constructs the
 * new value via the shared `buildPlacement()` (src/lib/cards.ts), so every
 * transition (kanban reorder, kanban<->timetable, timetable retime) follows
 * PLAN.md §1.3 exactly, and lands as one field write with one timestamp.
 */
export async function move(id: string, input: MoveInput): Promise<void> {
  const existing = await getOne(id);
  if (!existing) return;
  const placement = buildPlacement(existing.placement, input);
  await patch(id, { placement }, true);
}

/**
 * Patch a record — every field except `placement`. Only the fields you pass
 * get new timestamps.
 *
 * The `& { placement?: never }` type catches the common mistake (a literal,
 * or a variable typed to include `placement`) at the call site, in the
 * editor, before it ever runs. `patch()`'s runtime check above is the part
 * that's actually unconditional — it catches everything else, including a
 * deliberate type assertion that defeats the static guard.
 */
export async function update(
  id: string,
  fields: Partial<Pick<Todo, Exclude<Field, 'placement'>>> & { placement?: never },
): Promise<void> {
  await patch(id, fields);
}

/** Soft delete — tombstones are what let other devices learn about the removal. */
export const remove = (id: string) => update(id, { deleted: 1 });

/** Drops the local-only dirty flag. Removing the key beats setting it to
 *  undefined, which `exactOptionalPropertyTypes` rejects — and which would also
 *  put a useless `dirty: undefined` into IndexedDB. */
function clean(todo: Todo): Todo {
  const { dirty: _dirty, ...rest } = todo;
  return rest;
}

/**
 * Field-level last-write-wins, matching the server's rule exactly.
 *
 * Written out field by field rather than looped with a cast: it's the same
 * comparisons either way, and this version is checked by the compiler, so
 * renaming a field can't silently skip the merge for it.
 */
function merge(local: Todo | undefined, incoming: Todo): Todo {
  if (!local) return { ...incoming };
  const base = local;

  const wins = <K extends Field>(key: K): Todo[K] =>
    (incoming.ts?.[key] ?? 0) >= (base.ts?.[key] ?? 0) ? incoming[key] : base[key];

  const ts: Todo['ts'] = { ...base.ts };
  for (const f of FIELDS) {
    const inTs = incoming.ts?.[f] ?? 0;
    if (inTs >= (base.ts?.[f] ?? 0)) ts[f] = inTs;
  }

  return {
    ...base,
    title: wins('title'),
    notes: wins('notes'),
    done: wins('done'),
    due: wins('due'),
    deleted: wins('deleted'),
    placement: wins('placement'),
    minutes: wins('minutes'),
    ts,
  };
}

let inFlight: Promise<boolean> | null = null;

/**
 * Push local changes, pull everything new. Returns true if anything changed
 * locally, so the caller knows whether to re-render.
 *
 * Concurrent calls collapse into the one already running — visibilitychange,
 * the interval, and a user edit can all fire at once.
 */
export function sync(): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = run().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * The server pages its response, so one round-trip isn't always enough. Keep
 * pulling until it says we're caught up. Local changes only ride along on the
 * first pass; later passes are pure reads.
 *
 * The bound is a safety net against a server that never clears `more` — without
 * it a bug on either side becomes an infinite request loop in the browser.
 */
async function run(): Promise<boolean> {
  let changed = false;
  for (let pass = 0; pass < 50; pass++) {
    const { changed: didChange, more } = await roundTrip(pass === 0);
    changed = changed || didChange;
    if (!more) break;
  }
  return changed;
}

async function roundTrip(includeLocalWrites: boolean): Promise<{ changed: boolean; more: boolean }> {
  const cursor = (await getMeta<number>('cursor')) ?? 0;
  const all = await getAll();
  const dirty = includeLocalWrites ? all.filter((t) => t.dirty) : [];

  // Remember what we sent, so a concurrent edit during the request isn't
  // marked clean by this round-trip.
  const sent = new Map(dirty.map((t) => [t.id, stamp(t)]));

  const res = await fetch('/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cursor,
      changes: dirty.map(({ dirty: _d, ...rest }) => rest),
    }),
  });

  if (res.status === 401) {
    location.href = '/login?next=/';
    return { changed: false, more: false };
  }
  if (!res.ok) throw new Error(`sync failed: ${res.status}`);

  const body = (await res.json()) as { cursor: number; changes: Todo[]; more?: boolean };
  let changed = false;

  for (const incoming of body.changes) {
    const local = await getOne(incoming.id);
    const merged = merge(local, incoming);

    // Keep the flag only if this record was edited again while the request was
    // in flight; otherwise the round-trip has published everything we had.
    const editedSinceSend = Boolean(local?.dirty) && stamp(merged) > (sent.get(incoming.id) ?? -1);
    const next: Todo = editedSinceSend ? { ...merged, dirty: 1 } : clean(merged);

    if (JSON.stringify(local) !== JSON.stringify(next)) changed = true;
    await put(next);
  }

  // Clear the flag on anything we pushed that the server didn't echo back
  // (it merged to a no-op) and that hasn't been touched since.
  for (const [id, sentStamp] of sent) {
    const local = await getOne(id);
    if (local?.dirty && stamp(local) <= sentStamp) {
      await put(clean(local));
    }
  }

  await setMeta('cursor', body.cursor);
  return { changed, more: body.more === true };
}
