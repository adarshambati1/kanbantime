import { rankBetween } from './rank';

/**
 * Client-side local-first store.
 *
 * The rule that makes the app feel instant: the UI reads from IndexedDB and
 * never awaits the network. Writes land locally, mark the record dirty, and a
 * background sync reconciles. Offline isn't a mode — it's just sync not having
 * run yet.
 */

export const FIELDS = [
  'title',
  'notes',
  'done',
  'due',
  'deleted',
  'column',
  'rank',
  'minutes',
] as const;
export type Field = (typeof FIELDS)[number];

export interface Todo {
  id: string;
  title: string;
  notes: string;
  done: number;
  due: string | null;
  deleted: number;
  /** Board column id. */
  column: string;
  /** Fractional rank within the column — see src/lib/rank.ts. */
  rank: string;
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

const stamp = (t: Todo) => Math.max(0, ...Object.values(t.ts ?? {}));

export async function add(title: string, column = 'backlog'): Promise<Todo> {
  const now = Date.now();
  // Append: rank after whatever is currently last in that column.
  const existing = (await getAll()).filter((t) => !t.deleted && t.column === column);
  const last = existing.map((t) => t.rank).sort().pop() ?? null;

  const t: Todo = {
    id: crypto.randomUUID(),
    title: title.trim(),
    notes: '',
    done: 0,
    due: null,
    deleted: 0,
    column,
    rank: rankBetween(last, null),
    minutes: 30,
    ts: Object.fromEntries(FIELDS.map((f) => [f, now])) as Todo['ts'],
    dirty: 1,
  };
  await put(t);
  return t;
}

/**
 * Move a card to a position in a column.
 *
 * Takes the neighbours it should land between rather than an index, so this is
 * a single field write on a single row — see src/lib/rank.ts for why that
 * matters to the sync model.
 */
export async function move(
  id: string,
  column: string,
  before: string | null,
  after: string | null,
): Promise<void> {
  await update(id, { column, rank: rankBetween(before, after) });
}

/** Patch a record. Only the fields you pass get new timestamps. */
export async function update(id: string, patch: Partial<Pick<Todo, Field>>): Promise<void> {
  const existing = await getOne(id);
  if (!existing) return;
  const now = Date.now();
  const ts = { ...existing.ts };
  for (const k of Object.keys(patch) as Field[]) ts[k] = now;
  await put({ ...existing, ...patch, ts, dirty: 1 });
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
 * Written out field by field rather than looped with a cast: it's the same five
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
    column: wins('column'),
    rank: wins('rank'),
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
