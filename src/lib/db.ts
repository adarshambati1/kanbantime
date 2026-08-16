import { createClient, type Client } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Server-side store for todos.
 *
 * libSQL rather than a local SQLite file, because Vercel's filesystem is
 * ephemeral — anything written to disk is gone on the next invocation. The same
 * client speaks to a local file in development and to Turso in production, so
 * there's one code path and no "works on my machine" gap.
 *
 * Sync model (see README): every row carries a server-assigned monotonic `seq`.
 * Clients hold the highest `seq` they've seen and ask for everything above it.
 * That's the change-token approach — no reliance on device clocks for ordering,
 * no boundary bugs when two rows share a millisecond.
 *
 * Device clocks are still used, but only for conflict resolution, and per field
 * rather than per row (`ts`). Checking a box on your phone while editing the
 * title on your laptop merges cleanly instead of one write clobbering the other.
 */

export const FIELDS = ['title', 'notes', 'done', 'due', 'deleted'] as const;
export type Field = (typeof FIELDS)[number];

export interface Todo {
  id: string;
  title: string;
  notes: string;
  done: number;
  due: string | null;
  deleted: number;
  ts: Partial<Record<Field, number>>;
  seq: number;
}

/** What a client sends up. `seq` is server-owned, so it's absent on push. */
export type TodoInput = Omit<Todo, 'seq'>;

let _client: Client | null = null;
let _ready: Promise<Client> | null = null;

function connect(): Client {
  const url = process.env.TURSO_DATABASE_URL || 'file:./data/todos.db';
  const authToken = process.env.TURSO_AUTH_TOKEN;

  // libSQL won't create the parent directory for a file: URL, and a missing
  // one surfaces as an opaque failure on first query. Only relevant locally —
  // in production the URL is remote and there's no directory involved.
  if (url.startsWith('file:')) {
    mkdirSync(dirname(url.slice('file:'.length)), { recursive: true });
  }

  return createClient(authToken ? { url, authToken } : { url });
}

/** Connects and creates the schema once per warm instance. */
export function db(): Promise<Client> {
  if (_ready) return _ready;
  _ready = (async () => {
    const c = _client ?? (_client = connect());
    await c.batch(
      [
        `CREATE TABLE IF NOT EXISTS todos (
          id      TEXT PRIMARY KEY,
          title   TEXT    NOT NULL DEFAULT '',
          notes   TEXT    NOT NULL DEFAULT '',
          done    INTEGER NOT NULL DEFAULT 0,
          due     TEXT,
          deleted INTEGER NOT NULL DEFAULT 0,
          ts      TEXT    NOT NULL DEFAULT '{}',
          seq     INTEGER NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_todos_seq ON todos(seq)`,
        `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
        `INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', '0')`,
      ],
      'write',
    );
    return c;
  })();
  return _ready;
}

type Row = Record<string, unknown>;

const hydrate = (r: Row): Todo => ({
  id: String(r.id),
  title: String(r.title ?? ''),
  notes: String(r.notes ?? ''),
  done: Number(r.done ?? 0),
  due: r.due == null ? null : String(r.due),
  deleted: Number(r.deleted ?? 0),
  ts: safeParse(String(r.ts ?? '{}')),
  seq: Number(r.seq ?? 0),
});

function safeParse(s: string): Todo['ts'] {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Rows returned per pull. A client further behind than this pages through. */
export const PAGE_LIMIT = 1000;

/** Everything that changed after `cursor`, oldest first. */
export async function changesSince(cursor: number, limit: number = PAGE_LIMIT): Promise<Todo[]> {
  const c = await db();
  const res = await c.execute({
    sql: `SELECT * FROM todos WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
    args: [cursor, limit],
  });
  return res.rows.map((r) => hydrate(r as unknown as Row));
}

export async function currentSeq(): Promise<number> {
  const c = await db();
  const res = await c.execute(`SELECT v FROM meta WHERE k='seq'`);
  return Number((res.rows[0] as unknown as Row | undefined)?.v ?? 0);
}

/**
 * Field-level last-write-wins. For each field independently, the write with the
 * newer timestamp survives. Ties break on the incoming value so a retried push
 * is idempotent rather than flapping.
 */
function merge(existing: Todo | undefined, incoming: TodoInput): { row: TodoInput; changed: boolean } {
  if (!existing) return { row: incoming, changed: true };
  const base = existing;

  const wins = <K extends Field>(key: K): TodoInput[K] =>
    (incoming.ts?.[key] ?? 0) >= (base.ts?.[key] ?? 0) ? incoming[key] : base[key];

  const ts: Todo['ts'] = { ...base.ts };
  let changed = false;

  for (const f of FIELDS) {
    const inTs = incoming.ts?.[f] ?? 0;
    const exTs = base.ts?.[f] ?? 0;
    if (inTs < exTs) continue;
    // Keep the newer stamp even when the value is identical, so later merges
    // still compare correctly. This counts as a change in its own right — if we
    // only persisted on a differing value, the advanced stamp would be dropped
    // and a later write landing between the two timestamps could wrongly win.
    if (inTs > exTs || base[f] !== incoming[f]) changed = true;
    ts[f] = inTs;
  }

  const row: TodoInput = {
    ...base,
    title: wins('title'),
    notes: wins('notes'),
    done: wins('done'),
    due: wins('due'),
    deleted: wins('deleted'),
    ts,
  };

  return { row, changed };
}

/**
 * Apply a batch of client writes. Returns the caller's new cursor plus every
 * change above their old one — including the rows we just merged, so the client
 * always receives the authoritative post-merge version of its own writes.
 */
export async function push(
  incoming: TodoInput[],
  cursor: number,
): Promise<{ cursor: number; changes: Todo[]; more: boolean }> {
  const c = await db();

  if (incoming.length > 0) {
    const tx = await c.transaction('write');
    try {
      const seqRow = await tx.execute(`SELECT v FROM meta WHERE k='seq'`);
      let seq = Number((seqRow.rows[0] as unknown as Row | undefined)?.v ?? 0);

      for (const item of incoming) {
        const found = await tx.execute({
          sql: `SELECT * FROM todos WHERE id = ?`,
          args: [item.id],
        });
        const existing = found.rows[0] ? hydrate(found.rows[0] as unknown as Row) : undefined;
        const { row, changed } = merge(existing, item);
        if (!changed) continue;

        seq += 1;
        await tx.execute({
          sql: `INSERT INTO todos (id, title, notes, done, due, deleted, ts, seq)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  title=excluded.title, notes=excluded.notes, done=excluded.done,
                  due=excluded.due, deleted=excluded.deleted, ts=excluded.ts,
                  seq=excluded.seq`,
          args: [
            row.id,
            String(row.title ?? ''),
            String(row.notes ?? ''),
            row.done ? 1 : 0,
            row.due || null,
            row.deleted ? 1 : 0,
            JSON.stringify(row.ts ?? {}),
            seq,
          ],
        });
      }

      await tx.execute({ sql: `UPDATE meta SET v=? WHERE k='seq'`, args: [String(seq)] });
      await tx.commit();
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
  }

  const changes = await changesSince(cursor, PAGE_LIMIT);
  const truncated = changes.length === PAGE_LIMIT;

  // Only advance the caller's cursor as far as we actually sent. Jumping it to
  // the global latest would permanently skip every row past the page limit for
  // a client that's a long way behind.
  const nextCursor = truncated ? (changes[changes.length - 1]?.seq ?? cursor) : await currentSeq();

  return { cursor: nextCursor, changes, more: truncated };
}

/** Create a single todo server-side. Used by the Shortcuts/Siri endpoint. */
export async function quickAdd(title: string): Promise<Todo> {
  const now = Date.now();
  const id = crypto.randomUUID();
  const ts = Object.fromEntries(FIELDS.map((f) => [f, now])) as Todo['ts'];
  await push([{ id, title, notes: '', done: 0, due: null, deleted: 0, ts }], await currentSeq());

  const c = await db();
  const res = await c.execute({ sql: `SELECT * FROM todos WHERE id = ?`, args: [id] });
  return hydrate(res.rows[0] as unknown as Row);
}

/** Open todos, most recent first. Used by the Siri "what's on my list" read. */
export async function openTodos(): Promise<Todo[]> {
  const c = await db();
  const res = await c.execute(
    `SELECT * FROM todos WHERE done = 0 AND deleted = 0 ORDER BY seq DESC LIMIT 100`,
  );
  return res.rows.map((r) => hydrate(r as unknown as Row));
}
