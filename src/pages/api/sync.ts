import type { APIRoute } from 'astro';
import { push, type TodoInput } from '../../lib/db';

export const prerender = false;

/**
 * The whole sync protocol: send your cursor and your dirty records, get back a
 * new cursor and everything that changed above the old one.
 *
 * Auth is handled in middleware.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: { cursor?: number; changes?: TodoInput[] };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const cursor = Number.isFinite(body.cursor) ? Number(body.cursor) : 0;
  const changes = Array.isArray(body.changes) ? body.changes : [];

  if (changes.length > 5000) return json({ error: 'batch too large' }, 413);

  const clean = changes.filter(
    (c): c is TodoInput => !!c && typeof c.id === 'string' && c.id.length > 0 && c.id.length <= 64,
  );

  try {
    return json(await push(clean, cursor));
  } catch (err) {
    console.error('sync failed', err);
    return json({ error: 'sync failed' }, 500);
  }
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
