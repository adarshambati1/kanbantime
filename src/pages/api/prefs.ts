import type { APIRoute } from 'astro';
import { getColumns, getRetiredColumnIds, setColumnsSafe, setPref } from '../../lib/prefs';
import type { ColumnDef } from '../../lib/columns';

export const prerender = false;

/**
 * Board-presentation state: column config and small UI preferences. Small
 * enough (a handful of rows) to always send/receive everything — no cursor,
 * no paging, unlike /api/sync. See PLAN.md §1.4/§1.5.
 *
 * Auth is handled in middleware, same credential rule as /api/sync.
 */
export const GET: APIRoute = async () => {
  const [columns, retired] = await Promise.all([getColumns(), getRetiredColumnIds()]);
  return json({ columns, retired });
};

interface Body {
  /** Present to replace the column list — validated transactionally
   *  (PLAN.md §1.4): rejected if it would orphan a card or reuse a
   *  permanently-retired id. */
  columns?: ColumnDef[];
  /** Present to set one other preference, e.g. `ui.accent`. */
  key?: string;
  value?: unknown;
  ts?: number;
}

export const POST: APIRoute = async ({ request }) => {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const ts = Number.isFinite(body.ts) ? Number(body.ts) : Date.now();

  if (Array.isArray(body.columns)) {
    const result = await setColumnsSafe(body.columns, ts);
    if (!result.ok) return json({ error: 'columns blocked', blocking: result.blocking }, 409);
    return json({ ok: true });
  }

  if (typeof body.key === 'string' && body.key) {
    await setPref(body.key, body.value ?? null, ts);
    return json({ ok: true });
  }

  return json({ error: 'nothing to do' }, 400);
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
