import { db } from './db';

/**
 * Server-side store for notes — a second content type alongside todos, same
 * underlying patterns (field-level LWW, monotonic `seq` cursor, tombstone
 * deletes) because those are what make sync safe across devices, not
 * something specific to todos. See NOTES-PLAN.md §1.
 *
 * Own table, own `seq` counter, own sync endpoint (`/api/notes/sync`) — not
 * folded into the todo sync, since it's a different resource with different
 * fields; sharing a cursor with todos would just be two unrelated things
 * pretending to be one.
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
  seq: number;
  createdAt: number;
}

export type NoteInput = Omit<Note, 'seq'>;

type Row = Record<string, unknown>;

let _ready: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  if (_ready) return _ready;
  _ready = (async () => {
    const c = await db();
    await c.batch(
      [
        `CREATE TABLE IF NOT EXISTS notes (
          id         TEXT PRIMARY KEY,
          title      TEXT    NOT NULL DEFAULT '',
          body       TEXT    NOT NULL DEFAULT '',
          folder     TEXT    NOT NULL DEFAULT 'general',
          visibility TEXT    NOT NULL DEFAULT 'private',
          deleted    INTEGER NOT NULL DEFAULT 0,
          ts         TEXT    NOT NULL DEFAULT '{}',
          seq        INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_notes_seq ON notes(seq)`,
        `CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder)`,
        `CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_notes_visibility ON notes(visibility)`,
        `CREATE TABLE IF NOT EXISTS notes_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
        `INSERT OR IGNORE INTO notes_meta (k, v) VALUES ('seq', '0')`,
        // Plain (not external-content) FTS5 table, kept in sync explicitly in
        // application code (push(), below) rather than via SQL triggers —
        // simpler to reason about and test than external-content trigger
        // wiring, and at personal-notes scale a delete+reinsert on every
        // write is not a real cost.
        `CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(id UNINDEXED, title, body)`,
      ],
      'write',
    );
  })();
  return _ready;
}

function normalize(raw: Partial<NoteInput> & { id: string }): NoteInput {
  return {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    folder: typeof raw.folder === 'string' && raw.folder ? raw.folder : 'general',
    visibility: raw.visibility === 'public' ? 'public' : 'private',
    deleted: raw.deleted ? 1 : 0,
    ts: raw.ts && typeof raw.ts === 'object' ? raw.ts : {},
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
  };
}

/**
 * The publish lock (NOTES-PLAN.md §1.1): a note that's currently public
 * can't have its content changed unless the same write also takes it
 * private. Enforced here, at the one choke point every write — the in-app
 * editor, the MCP tool, and a raw sync push alike — actually goes through,
 * not just in a higher-level convenience wrapper a sync push could bypass.
 *
 * Resilient, not fatal, at this layer: rather than rejecting the whole
 * incoming item (which would break sync's offline-resilience guarantee for
 * every *other* field on it), the offending content fields are reverted to
 * their existing values and everything else in the write still applies.
 * `updateNote()` below is where a direct caller (editor, MCP) gets an
 * actual rejection it can act on — this is the backstop under it.
 */
function applyPublishLock(existing: Note | undefined, incoming: NoteInput): NoteInput {
  if (!existing || existing.visibility !== 'public') return incoming;

  const incomingVisTs = incoming.ts?.visibility ?? 0;
  const existingVisTs = existing.ts?.visibility ?? 0;
  const goingPrivate = incoming.visibility === 'private' && incomingVisTs >= existingVisTs;
  if (goingPrivate) return incoming;

  // Reverted fields must get a timestamp *newer* than what the client sent,
  // not reverted back to the old existing timestamp — a client's own naive
  // "higher timestamp wins" merge (notesStore.ts, and any other client)
  // can't tell "the server hasn't seen my write yet" apart from "the server
  // saw it and deliberately overrode it." If the echo carries an *older*
  // timestamp than what the client sent, the client's own merge concludes
  // its own (rejected) value is still the newest thing anyone wrote, silently
  // re-adopts it locally, and clears the dirty flag — the edit never landed
  // but the UI reports it as saved. Bumping strictly past the incoming
  // timestamp (mirroring how db.ts's minutes-clamp corrects a value while
  // preserving — never rewinding — its timestamp) closes that: any client
  // comparing against what it sent will see the correction as newer and
  // adopt it for real.
  const revert = (field: 'title' | 'body' | 'folder'): number =>
    Math.max(incoming.ts?.[field] ?? 0, existing.ts?.[field] ?? 0) + 1;

  return {
    ...incoming,
    title: existing.title,
    body: existing.body,
    folder: existing.folder,
    ts: {
      ...incoming.ts,
      title: revert('title'),
      body: revert('body'),
      folder: revert('folder'),
    },
  };
}

const hydrate = (r: Row): Note => ({
  id: String(r.id),
  title: String(r.title ?? ''),
  body: String(r.body ?? ''),
  folder: String(r.folder ?? 'general'),
  visibility: r.visibility === 'public' ? 'public' : 'private',
  deleted: Number(r.deleted ?? 0),
  ts: safeParse(String(r.ts ?? '{}')),
  seq: Number(r.seq ?? 0),
  createdAt: Number(r.created_at ?? 0),
});

function safeParse(s: string): Note['ts'] {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export const PAGE_LIMIT = 1000;

export async function changesSince(cursor: number, limit: number = PAGE_LIMIT): Promise<Note[]> {
  await ensureSchema();
  const c = await db();
  const res = await c.execute({
    sql: `SELECT * FROM notes WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
    args: [cursor, limit],
  });
  return res.rows.map((r) => hydrate(r as unknown as Row));
}

export async function currentSeq(): Promise<number> {
  await ensureSchema();
  const c = await db();
  const res = await c.execute(`SELECT v FROM notes_meta WHERE k='seq'`);
  return Number((res.rows[0] as unknown as Row | undefined)?.v ?? 0);
}

function merge(existing: Note | undefined, incoming: NoteInput): { row: NoteInput; changed: boolean } {
  if (!existing) return { row: incoming, changed: true };
  const base = existing;

  const wins = <K extends NoteField>(key: K): NoteInput[K] =>
    (incoming.ts?.[key] ?? 0) >= (base.ts?.[key] ?? 0) ? incoming[key] : base[key];

  const ts: Note['ts'] = { ...base.ts };
  let changed = false;

  for (const f of NOTE_FIELDS) {
    const inTs = incoming.ts?.[f] ?? 0;
    const exTs = base.ts?.[f] ?? 0;
    if (inTs < exTs) continue;
    if (inTs > exTs || base[f] !== incoming[f]) changed = true;
    ts[f] = inTs;
  }

  const row: NoteInput = {
    ...base,
    title: wins('title'),
    body: wins('body'),
    folder: wins('folder'),
    visibility: wins('visibility'),
    deleted: wins('deleted'),
    ts,
    createdAt: base.createdAt,
  };

  return { row, changed };
}

export async function push(
  incoming: NoteInput[],
  cursor: number,
): Promise<{ cursor: number; changes: Note[]; more: boolean }> {
  await ensureSchema();
  const c = await db();

  if (incoming.length > 0) {
    const tx = await c.transaction('write');
    try {
      const seqRow = await tx.execute(`SELECT v FROM notes_meta WHERE k='seq'`);
      let seq = Number((seqRow.rows[0] as unknown as Row | undefined)?.v ?? 0);

      for (const raw of incoming) {
        const found = await tx.execute({ sql: `SELECT * FROM notes WHERE id = ?`, args: [raw.id] });
        const existing = found.rows[0] ? hydrate(found.rows[0] as unknown as Row) : undefined;

        const normalized = normalize(raw);
        const locked = applyPublishLock(existing, normalized);
        const { row, changed } = merge(existing, locked);
        if (!changed) continue;

        seq += 1;
        const createdAt = existing?.createdAt ?? row.createdAt;
        await tx.execute({
          sql: `INSERT INTO notes (id, title, body, folder, visibility, deleted, ts, seq, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  title=excluded.title, body=excluded.body, folder=excluded.folder,
                  visibility=excluded.visibility, deleted=excluded.deleted, ts=excluded.ts, seq=excluded.seq`,
          args: [
            row.id,
            row.title,
            row.body,
            row.folder,
            row.visibility,
            row.deleted ? 1 : 0,
            JSON.stringify(row.ts ?? {}),
            seq,
            createdAt,
          ],
        });

        await tx.execute({ sql: `DELETE FROM notes_fts WHERE id = ?`, args: [row.id] });
        if (!row.deleted) {
          await tx.execute({
            sql: `INSERT INTO notes_fts (id, title, body) VALUES (?, ?, ?)`,
            args: [row.id, row.title, row.body],
          });
        }
      }

      await tx.execute({ sql: `UPDATE notes_meta SET v=? WHERE k='seq'`, args: [String(seq)] });
      await tx.commit();
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
  }

  const changes = await changesSince(cursor, PAGE_LIMIT);
  const truncated = changes.length === PAGE_LIMIT;
  const nextCursor = truncated ? (changes[changes.length - 1]?.seq ?? cursor) : await currentSeq();

  return { cursor: nextCursor, changes, more: truncated };
}

export async function getNote(id: string): Promise<Note | undefined> {
  await ensureSchema();
  const c = await db();
  const res = await c.execute({ sql: `SELECT * FROM notes WHERE id = ?`, args: [id] });
  const row = res.rows[0] as unknown as Row | undefined;
  return row ? hydrate(row) : undefined;
}

export async function listNotes(folder?: string): Promise<Note[]> {
  await ensureSchema();
  const c = await db();
  const res = folder
    ? await c.execute({
        sql: `SELECT * FROM notes WHERE deleted = 0 AND folder = ? ORDER BY created_at DESC`,
        args: [folder],
      })
    : await c.execute(`SELECT * FROM notes WHERE deleted = 0 ORDER BY created_at DESC`);
  return res.rows.map((r) => hydrate(r as unknown as Row));
}

export async function notesByDate(fromMs: number, toMs: number): Promise<Note[]> {
  await ensureSchema();
  const c = await db();
  const res = await c.execute({
    sql: `SELECT * FROM notes WHERE deleted = 0 AND created_at >= ? AND created_at <= ? ORDER BY created_at DESC`,
    args: [fromMs, toMs],
  });
  return res.rows.map((r) => hydrate(r as unknown as Row));
}

export interface GrepOptions {
  folder?: string | undefined;
  fromMs?: number | undefined;
  toMs?: number | undefined;
}

/** Escapes an FTS5 MATCH query so arbitrary user text can't be interpreted
 *  as FTS5 query syntax (column filters, boolean operators, etc.) — every
 *  term is treated as a literal phrase to search for. */
function ftsQuery(text: string): string {
  const terms = text
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  return terms.join(' ');
}

export async function grepNotes(query: string, opts: GrepOptions = {}): Promise<Note[]> {
  await ensureSchema();
  const c = await db();
  const q = ftsQuery(query);
  if (!q) return [];

  const conditions = ['n.deleted = 0'];
  const args: (string | number)[] = [q];
  if (opts.folder) {
    conditions.push('n.folder = ?');
    args.push(opts.folder);
  }
  if (opts.fromMs !== undefined) {
    conditions.push('n.created_at >= ?');
    args.push(opts.fromMs);
  }
  if (opts.toMs !== undefined) {
    conditions.push('n.created_at <= ?');
    args.push(opts.toMs);
  }

  const res = await c.execute({
    sql: `SELECT n.* FROM notes n
          JOIN notes_fts f ON f.id = n.id
          WHERE f.notes_fts MATCH ? AND ${conditions.join(' AND ')}
          ORDER BY rank`,
    args,
  });
  return res.rows.map((r) => hydrate(r as unknown as Row));
}

export interface UpdateResult {
  ok: boolean;
  reason?: 'locked' | 'not_found';
  note?: Note | undefined;
}

/**
 * The direct-caller path (in-app editor, MCP `update_note`) — same publish
 * lock as the sync path, but returns an explicit rejection instead of
 * silently dropping the content change, since a human or an agent making a
 * deliberate edit needs to know it didn't land and why.
 */
export async function updateNote(
  id: string,
  patch: Partial<Pick<Note, 'title' | 'body' | 'folder' | 'visibility'>>,
): Promise<UpdateResult> {
  const existing = await getNote(id);
  if (!existing || existing.deleted) return { ok: false, reason: 'not_found' };

  const changesContent = patch.title !== undefined || patch.body !== undefined || patch.folder !== undefined;
  const staysPublic = (patch.visibility ?? existing.visibility) === 'public';
  if (existing.visibility === 'public' && changesContent && staysPublic) {
    return { ok: false, reason: 'locked' };
  }

  const now = Date.now();
  const fields = Object.keys(patch) as NoteField[];
  const ts: Note['ts'] = { ...existing.ts };
  for (const f of fields) ts[f] = now;

  await push([{ ...existing, ...patch, ts, deleted: existing.deleted }], await currentSeq());
  const note = await getNote(id);
  return { ok: true, note };
}

export async function createNote(input: {
  title: string;
  body: string;
  folder?: string;
  visibility?: Visibility;
}): Promise<Note> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const ts = Object.fromEntries(NOTE_FIELDS.map((f) => [f, now])) as Note['ts'];
  await push(
    [
      {
        id,
        title: input.title,
        body: input.body,
        folder: input.folder ?? 'general',
        visibility: input.visibility ?? 'private',
        deleted: 0,
        ts,
        createdAt: now,
      },
    ],
    await currentSeq(),
  );
  const note = await getNote(id);
  if (!note) throw new Error('note vanished immediately after create');
  return note;
}

export async function forgetNote(id: string): Promise<boolean> {
  const existing = await getNote(id);
  if (!existing || existing.deleted) return false;
  const now = Date.now();
  await push(
    [{ ...existing, deleted: 1, ts: { ...existing.ts, deleted: now } }],
    await currentSeq(),
  );
  return true;
}
