import { createClient, type Client } from '@libsql/client';
import { rankBetween } from './rank';
import { DEFAULT_COLUMNS, fallbackColumn, type ColumnDef } from './columns';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Everything below only needs `execute` — both a `Client` and a
 *  `Transaction` satisfy this, so the same helpers work whether they're
 *  called at top level or from inside a `push()` transaction. */
type Executor = { execute: Client['execute'] };

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
 *
 * `column`/`rank`/`start` are NOT three independent fields — see `Placement`
 * below and PLAN.md §1.1. Merging them independently let a concurrent move and
 * a concurrent retime recombine into a card nobody actually produced; they're
 * one field, `placement`, with one timestamp, so a write wins or loses whole.
 */

export interface Placement {
  column: string;
  /** Fractional rank — meaningful for a kanban column, or for a card sitting
   *  in a timetable column's unscheduled tray. See src/lib/rank.ts. */
  rank: string;
  /** Minutes since local midnight, or null — meaningful only once a card is
   *  placed on a timetable column's axis. */
  start: number | null;
}

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

type Row = Record<string, unknown>;

/**
 * Adds `placement` (and backfills it from the legacy `col`/`rank` columns)
 * to a database that predates it. Idempotent and safe under a concurrent
 * cold start racing the same `ALTER TABLE` — the loser's statement fails
 * with "duplicate column name", which is expected and swallowed; either way
 * the backfill `UPDATE` below still runs, since it's a no-op wherever
 * `placement` is already set.
 */
async function migrate(c: Client): Promise<void> {
  const cols = await c.execute(`PRAGMA table_info(todos)`);
  const have = new Set((cols.rows as unknown as Row[]).map((r) => String(r.name)));
  if (!have.has('placement')) {
    try {
      await c.execute(`ALTER TABLE todos ADD COLUMN placement TEXT`);
    } catch (err) {
      if (!String(err).includes('duplicate column name')) throw err;
    }
  }
  await c.execute(
    `UPDATE todos SET placement = json_object('column', col, 'rank', rank, 'start', NULL) WHERE placement IS NULL`,
  );
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
          seq     INTEGER NOT NULL,
          col     TEXT    NOT NULL DEFAULT 'backlog',
          rank    TEXT    NOT NULL DEFAULT 'm',
          minutes INTEGER NOT NULL DEFAULT 30
        )`,
        `CREATE INDEX IF NOT EXISTS idx_todos_seq ON todos(seq)`,
        `CREATE INDEX IF NOT EXISTS idx_todos_col ON todos(col, rank)`,
        `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
        `INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', '0')`,
        `CREATE TABLE IF NOT EXISTS prefs (k TEXT PRIMARY KEY, v TEXT NOT NULL, ts INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS agent_proposals (
          id         TEXT PRIMARY KEY,
          actions    TEXT NOT NULL,
          status     TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )`,
      ],
      'write',
    );
    await migrate(c);
    return c;
  })();
  return _ready;
}

function parsePlacement(raw: unknown, legacyCol: unknown, legacyRank: unknown): Placement {
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object') {
        return {
          column: typeof v.column === 'string' && v.column ? v.column : 'backlog',
          rank: typeof v.rank === 'string' && v.rank ? v.rank : 'm',
          start: typeof v.start === 'number' ? v.start : null,
        };
      }
    } catch {
      /* fall through to the legacy shadow columns below */
    }
  }
  return { column: String(legacyCol ?? 'backlog'), rank: String(legacyRank ?? 'm'), start: null };
}

const hydrate = (r: Row): Todo => ({
  id: String(r.id),
  title: String(r.title ?? ''),
  notes: String(r.notes ?? ''),
  done: Number(r.done ?? 0),
  due: r.due == null ? null : String(r.due),
  deleted: Number(r.deleted ?? 0),
  placement: parsePlacement(r.placement, r.col, r.rank),
  minutes: Number(r.minutes ?? 30),
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

/** The board's current column config — falls back to the defaults if the
 *  `prefs` row is missing, empty, or malformed. Never throws. */
async function currentColumns(c: Executor): Promise<ColumnDef[]> {
  const res = await c.execute(`SELECT v FROM prefs WHERE k = 'columns'`);
  const raw = (res.rows[0] as unknown as Row | undefined)?.v;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as ColumnDef[];
    } catch {
      /* fall through to defaults */
    }
  }
  return DEFAULT_COLUMNS;
}

/**
 * Validates and repairs a `placement` value in place, on every write path
 * (`/api/sync`, `quickAdd`, and later the agent), unconditionally — even for
 * a deleted (tombstoned) row, so a resurrection can never bring back a card
 * pointing at a column that no longer exists (PLAN.md §1.2/§1.4).
 *
 * Never rejects the row — rejecting would break the sync protocol's
 * always-accept-and-merge guarantee offline resilience depends on. A bad
 * `column` is remapped to the fallback; a missing/empty `rank` is
 * regenerated; an out-of-range `start` is dropped to `null`.
 */
async function repairPlacement(c: Executor, p: Placement): Promise<Placement> {
  const columns = await currentColumns(c);
  const validIds = new Set(columns.map((col) => col.id));
  const fixedColumn = validIds.has(p.column) ? p.column : fallbackColumn(columns);

  let fixedRank = p.rank;
  if (typeof fixedRank !== 'string' || fixedRank.length === 0) {
    fixedRank = await rankAfterLast(c, fixedColumn);
  }

  const fixedStart =
    typeof p.start === 'number' && Number.isInteger(p.start) && p.start >= 0 && p.start <= 1439
      ? p.start
      : null;

  return { column: fixedColumn, rank: fixedRank, start: fixedStart };
}

function normalizePlacement(raw: unknown): Placement {
  if (raw && typeof raw === 'object') {
    const v = raw as Record<string, unknown>;
    return {
      column: typeof v.column === 'string' && v.column ? v.column : 'backlog',
      rank: typeof v.rank === 'string' ? v.rank : '',
      start: typeof v.start === 'number' ? v.start : null,
    };
  }
  return { column: 'backlog', rank: '', start: null };
}

/**
 * Field-level last-write-wins. For each field independently, the write with the
 * newer timestamp survives. Ties break on the incoming value so a retried push
 * is idempotent rather than flapping.
 *
 * `placement` is one field like any other here — the whole object wins or
 * loses together, which is what closes the incoherent-recombination bug
 * described in PLAN.md §1.1.
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
    if (inTs > exTs || JSON.stringify(base[f]) !== JSON.stringify(incoming[f])) changed = true;
    ts[f] = inTs;
  }

  const row: TodoInput = {
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

      for (const raw of incoming) {
        // Normalize and validate `placement` once, at ingestion, before merge
        // ever runs — not just on the base/local side, so an incoming payload
        // missing the field (a stale client) can't let an undefined value win.
        const placement = await repairPlacement(tx, normalizePlacement(raw.placement));
        const item: TodoInput = {
          ...raw,
          placement,
          // Nothing above bounds `minutes` on the high end today — an
          // unbounded value (typo, bad agent call) could otherwise dominate
          // or break the timetable layout (PLAN.md §3).
          minutes: Math.min(720, Math.max(5, Math.round(Number(raw.minutes) || 30))),
        };

        const found = await tx.execute({
          sql: `SELECT * FROM todos WHERE id = ?`,
          args: [item.id],
        });
        const existing = found.rows[0] ? hydrate(found.rows[0] as unknown as Row) : undefined;
        const { row, changed } = merge(existing, item);
        if (!changed) continue;

        seq += 1;
        await tx.execute({
          sql: `INSERT INTO todos (id, title, notes, done, due, deleted, ts, seq, col, rank, minutes, placement)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  title=excluded.title, notes=excluded.notes, done=excluded.done,
                  due=excluded.due, deleted=excluded.deleted, ts=excluded.ts,
                  seq=excluded.seq, col=excluded.col, rank=excluded.rank,
                  minutes=excluded.minutes, placement=excluded.placement`,
          args: [
            row.id,
            String(row.title ?? ''),
            String(row.notes ?? ''),
            row.done ? 1 : 0,
            row.due || null,
            row.deleted ? 1 : 0,
            JSON.stringify(row.ts ?? {}),
            seq,
            // `col`/`rank` are derived, non-authoritative shadow columns —
            // written from `placement` in this same statement so they can
            // never drift out of sync, kept only so `idx_todos_col` still
            // indexes a plain column for a single-column read.
            row.placement.column,
            row.placement.rank,
            row.minutes,
            JSON.stringify(row.placement),
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
export async function quickAdd(title: string, column = 'backlog'): Promise<Todo> {
  const now = Date.now();
  const id = crypto.randomUUID();
  const ts = Object.fromEntries(FIELDS.map((f) => [f, now])) as Todo['ts'];
  const c = await db();
  // Land at the end of the column so a dictated task doesn't jump the queue.
  const rank = await rankAfterLast(c, column);
  await push(
    [
      {
        id,
        title,
        notes: '',
        done: 0,
        due: null,
        deleted: 0,
        placement: { column, rank, start: null },
        minutes: 30,
        ts,
      },
    ],
    await currentSeq(),
  );

  const res = await c.execute({ sql: `SELECT * FROM todos WHERE id = ?`, args: [id] });
  return hydrate(res.rows[0] as unknown as Row);
}

/** The largest rank currently in a column, or null if it's empty. Reads the
 *  derived `col`/`rank` shadow columns — a query optimization only, never
 *  independently written or timestamped, so it can't drift from `placement`. */
async function lastRank(c: Executor, column: string): Promise<string | null> {
  const res = await c.execute({
    sql: `SELECT rank FROM todos WHERE col = ? AND deleted = 0 ORDER BY rank DESC LIMIT 1`,
    args: [column],
  });
  const row = res.rows[0] as unknown as Row | undefined;
  return row ? String(row.rank) : null;
}

async function rankAfterLast(c: Executor, column: string): Promise<string> {
  return rankBetween(await lastRank(c, column), null);
}

/** Open todos, most recent first. Used by the Siri "what's on my list" read. */
export async function openTodos(): Promise<Todo[]> {
  const c = await db();
  const res = await c.execute(
    `SELECT * FROM todos WHERE done = 0 AND deleted = 0 ORDER BY seq DESC LIMIT 100`,
  );
  return res.rows.map((r) => hydrate(r as unknown as Row));
}
