import type { Client } from '@libsql/client';
import { db } from './db';
import { DEFAULT_COLUMNS, type ColumnDef } from './columns';

/**
 * Board-presentation state that isn't a card: column config and small UI
 * preferences. One row per key (not one JSON blob for everything), each with
 * its own timestamp — plain whole-value LWW per row, so two devices changing
 * *different* preferences both survive instead of one clobbering the other.
 * See PLAN.md §1.4/§1.5.
 */

type Row = Record<string, unknown>;

async function getRaw(c: Client, k: string): Promise<{ v: unknown; ts: number } | null> {
  const res = await c.execute({ sql: `SELECT v, ts FROM prefs WHERE k = ?`, args: [k] });
  const row = res.rows[0] as unknown as Row | undefined;
  if (!row) return null;
  try {
    return { v: JSON.parse(String(row.v)), ts: Number(row.ts) };
  } catch {
    return null;
  }
}

export async function getColumns(): Promise<ColumnDef[]> {
  const c = await db();
  const row = await getRaw(c, 'columns');
  if (!row || !Array.isArray(row.v) || row.v.length === 0) return DEFAULT_COLUMNS;
  return row.v as ColumnDef[];
}

export async function getRetiredColumnIds(): Promise<string[]> {
  const c = await db();
  const row = await getRaw(c, 'columns.retired');
  if (!row || !Array.isArray(row.v)) return [];
  return row.v as string[];
}

/** Every non-column pref (e.g. `ui.accent`) goes through here — plain
 *  per-row LWW, ignored if a newer write already landed. */
export async function setPref(k: string, v: unknown, ts: number): Promise<void> {
  const c = await db();
  await c.execute({
    sql: `INSERT INTO prefs (k, v, ts) VALUES (?, ?, ?)
          ON CONFLICT(k) DO UPDATE SET v = excluded.v, ts = excluded.ts
          WHERE excluded.ts >= prefs.ts`,
    args: [k, JSON.stringify(v), ts],
  });
}

export async function getPref(k: string): Promise<unknown> {
  const c = await db();
  const row = await getRaw(c, k);
  return row?.v ?? null;
}

export interface ColumnRemovalBlocked {
  ok: false;
  blocking: { column: string; count: number }[];
}

/**
 * Replace the column list. A column that's being removed or changing `kind`
 * is only allowed through if no non-deleted card still references it — that
 * check and the write happen inside one transaction, so a card can't be
 * created/moved into the target column in the gap between "is it empty" and
 * "remove it" (PLAN.md §1.4). A retired id is reserved permanently: it can
 * never be reused by a later column, even after the removal that retired it.
 */
export async function setColumnsSafe(
  next: ColumnDef[],
  ts: number,
): Promise<{ ok: true } | ColumnRemovalBlocked> {
  if (next.length === 0) {
    return { ok: false, blocking: [{ column: '(all)', count: -1 }] };
  }

  const c = await db();
  const current = await getColumns();
  const retired = await getRetiredColumnIds();
  const nextIds = new Set(next.map((col) => col.id));

  for (const col of next) {
    const isNewToTheList = !current.some((existing) => existing.id === col.id);
    if (isNewToTheList && retired.includes(col.id)) {
      return { ok: false, blocking: [{ column: col.id, count: -1 }] };
    }
  }

  const removedOrChangedKind = current.filter((existing) => {
    const match = next.find((n) => n.id === existing.id);
    return !match || match.kind !== existing.kind;
  });

  const tx = await c.transaction('write');
  try {
    const blocking: { column: string; count: number }[] = [];
    for (const col of removedOrChangedKind) {
      const res = await tx.execute({
        sql: `SELECT COUNT(*) AS n FROM todos WHERE col = ? AND deleted = 0`,
        args: [col.id],
      });
      const n = Number((res.rows[0] as unknown as Row | undefined)?.n ?? 0);
      if (n > 0) blocking.push({ column: col.id, count: n });
    }

    if (blocking.length > 0) {
      await tx.rollback();
      return { ok: false, blocking };
    }

    const newlyRetired = current.map((col) => col.id).filter((id) => !nextIds.has(id));
    const retiredNext = [...new Set([...retired, ...newlyRetired])];

    await tx.execute({
      sql: `INSERT INTO prefs (k, v, ts) VALUES ('columns', ?, ?)
            ON CONFLICT(k) DO UPDATE SET v = excluded.v, ts = excluded.ts
            WHERE excluded.ts >= prefs.ts`,
      args: [JSON.stringify(next), ts],
    });
    await tx.execute({
      sql: `INSERT INTO prefs (k, v, ts) VALUES ('columns.retired', ?, ?)
            ON CONFLICT(k) DO UPDATE SET v = excluded.v, ts = excluded.ts
            WHERE excluded.ts >= prefs.ts`,
      args: [JSON.stringify(retiredNext), ts],
    });
    await tx.commit();
    return { ok: true };
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}
