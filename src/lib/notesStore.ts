/**
 * Client-side local-first store for notes — same rule as the todo store
 * (src/lib/store.ts): the UI reads from IndexedDB and never awaits the
 * network, writes land locally and mark the record dirty, a background sync
 * reconciles. Own IndexedDB database, not new object stores bolted onto the
 * todo one — keeps the two independent rather than coupling their schema
 * versions together.
 */

export const NOTE_FIELDS = ['title', 'body', 'folder', 'visibility', 'deleted'] as const;
export type NoteField = (typeof NOTE_FIELDS)[number];
export type Visibility = 'private' | 'public';

export interface Note {
  id: string;
  title: string;
  body: string;
  folder: string;
  visibility: Visibility;
  deleted: number;
  ts: Partial<Record<NoteField, number>>;
  createdAt: number;
  /** Local-only: set when this record has unpushed changes. Stripped on send. */
  dirty?: number;
}

const DB_NAME = 'kanban-notes';
const STORE = 'notes';
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

const getAll = () => tx<Note[]>(STORE, 'readonly', (s) => s.getAll());
const getOne = (id: string) => tx<Note | undefined>(STORE, 'readonly', (s) => s.get(id));
const put = (n: Note) => tx(STORE, 'readwrite', (s) => s.put(n));
const getMeta = <T>(k: string) => tx<T>(META, 'readonly', (s) => s.get(k));
const setMeta = (k: string, v: unknown) => tx(META, 'readwrite', (s) => s.put(v, k));

/** Newest first, optionally scoped to one folder. Full-text search
 *  (`grepNotes` in notesDb.ts) needs FTS5 and so is server-only — this is
 *  everything that can be answered from the already-synced local copy. */
export async function list(folder?: string): Promise<Note[]> {
  const all = await getAll();
  return all
    .filter((n) => !n.deleted && (!folder || n.folder === folder))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function listByDate(fromMs: number, toMs: number): Promise<Note[]> {
  const all = await getAll();
  return all
    .filter((n) => !n.deleted && n.createdAt >= fromMs && n.createdAt <= toMs)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Folder names in use, for the picker — not a separate concept from "the
 *  folder value some note currently has," so nothing to keep in sync. */
export async function folders(): Promise<string[]> {
  const all = await getAll();
  return [...new Set(all.filter((n) => !n.deleted).map((n) => n.folder))].sort();
}

export async function create(title: string, body: string, folder = 'general'): Promise<Note> {
  const now = Date.now();
  const note: Note = {
    id: crypto.randomUUID(),
    title: title.trim(),
    body,
    folder,
    visibility: 'private',
    deleted: 0,
    ts: Object.fromEntries(NOTE_FIELDS.map((f) => [f, now])) as Note['ts'],
    createdAt: now,
    dirty: 1,
  };
  await put(note);
  return note;
}

/** Writes any field, including `deleted` — not exported. `update()`/
 *  `forget()` below are the public surface. */
async function patch(id: string, fields: Partial<Pick<Note, NoteField>>): Promise<void> {
  const existing = await getOne(id);
  if (!existing) return;
  const now = Date.now();
  const ts = { ...existing.ts };
  for (const k of Object.keys(fields) as NoteField[]) ts[k] = now;
  await put({ ...existing, ...fields, ts, dirty: 1 });
}

export interface UpdateResult {
  ok: boolean;
  reason?: 'locked' | 'not_found';
  note?: Note | undefined;
}

/**
 * The publish lock (NOTES-PLAN.md §1.1), checked here for immediate
 * feedback — no round trip needed to tell the user "unpublish first." The
 * server enforces the same rule independently in notesDb.ts's `push()`, so
 * a stale local copy (this device hasn't synced a just-published change
 * yet) can't actually smuggle a content edit through even if this check,
 * working from stale data, lets it past.
 */
export async function update(
  id: string,
  fields: Partial<Pick<Note, 'title' | 'body' | 'folder' | 'visibility'>>,
): Promise<UpdateResult> {
  const existing = await getOne(id);
  if (!existing) return { ok: false, reason: 'not_found' };

  const changesContent = fields.title !== undefined || fields.body !== undefined || fields.folder !== undefined;
  const staysPublic = (fields.visibility ?? existing.visibility) === 'public';
  if (existing.visibility === 'public' && changesContent && staysPublic) {
    return { ok: false, reason: 'locked' };
  }

  await patch(id, fields);
  const note = await getOne(id);
  return { ok: true, note };
}

/** Soft delete — allowed regardless of `visibility`. Deleting isn't the
 *  silent-content-swap-under-a-public-reader's-feet risk the publish lock
 *  exists to prevent; it removes the note from public view too. */
export const forget = (id: string) => patch(id, { deleted: 1 });

function clean(note: Note): Note {
  const { dirty: _dirty, ...rest } = note;
  return rest;
}

/**
 * Caches a note fetched from a server response that isn't necessarily in
 * the local store yet — a full-text search result, most likely, since
 * `grepNotes()` runs server-side and can surface a note from another
 * device this one hasn't pulled down yet. Never overwrites a dirty local
 * copy: an unsynced local edit shouldn't be clobbered by a read-only
 * search result that's potentially staler than what the user just typed.
 */
export async function adopt(note: Note): Promise<void> {
  const local = await getOne(note.id);
  if (local?.dirty) return;
  await put(clean(note));
}

const stamp = (n: Note) => Math.max(0, ...Object.values(n.ts ?? {}));

/** Field-level last-write-wins, matching the server's rule exactly — same
 *  pattern as the todo store's merge(), just for NOTE_FIELDS. */
function merge(local: Note | undefined, incoming: Note): Note {
  if (!local) return { ...incoming };
  const base = local;

  const wins = <K extends NoteField>(key: K): Note[K] =>
    (incoming.ts?.[key] ?? 0) >= (base.ts?.[key] ?? 0) ? incoming[key] : base[key];

  const ts: Note['ts'] = { ...base.ts };
  for (const f of NOTE_FIELDS) {
    const inTs = incoming.ts?.[f] ?? 0;
    if (inTs >= (base.ts?.[f] ?? 0)) ts[f] = inTs;
  }

  return {
    ...base,
    title: wins('title'),
    body: wins('body'),
    folder: wins('folder'),
    visibility: wins('visibility'),
    deleted: wins('deleted'),
    ts,
  };
}

let inFlight: Promise<boolean> | null = null;

export function sync(): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = run().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

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
  const dirty = includeLocalWrites ? all.filter((n) => n.dirty) : [];
  const sent = new Map(dirty.map((n) => [n.id, stamp(n)]));

  const res = await fetch('/api/notes/sync', {
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
  if (!res.ok) throw new Error(`notes sync failed: ${res.status}`);

  const body = (await res.json()) as { cursor: number; changes: Note[]; more?: boolean };
  let changed = false;

  for (const incoming of body.changes) {
    const local = await getOne(incoming.id);
    const merged = merge(local, incoming);

    const editedSinceSend = Boolean(local?.dirty) && stamp(merged) > (sent.get(incoming.id) ?? -1);
    const next: Note = editedSinceSend ? { ...merged, dirty: 1 } : clean(merged);

    if (JSON.stringify(local) !== JSON.stringify(next)) changed = true;
    await put(next);
  }

  for (const [id, sentStamp] of sent) {
    const local = await getOne(id);
    if (local?.dirty && stamp(local) <= sentStamp) {
      await put(clean(local));
    }
  }

  await setMeta('cursor', body.cursor);
  return { changed, more: body.more === true };
}
