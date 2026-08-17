import type { APIRoute } from 'astro';
import { push, type NoteInput } from '../../../lib/notesDb';

export const prerender = false;

/**
 * Same protocol as /api/sync, for notes instead of todos — own cursor, own
 * resource, same shape on purpose (see NOTES-PLAN.md §1).
 *
 * Auth is handled in middleware.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: { cursor?: number; changes?: NoteInput[] };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const cursor = Number.isFinite(body.cursor) ? Number(body.cursor) : 0;
  const changes = Array.isArray(body.changes) ? body.changes : [];

  if (changes.length > 5000) return json({ error: 'batch too large' }, 413);

  const clean = changes.filter(
    (c): c is NoteInput => !!c && typeof c.id === 'string' && c.id.length > 0 && c.id.length <= 64,
  );

  try {
    return json(await push(clean, cursor));
  } catch (err) {
    console.error('notes sync failed', err);
    return json({ error: 'sync failed' }, 500);
  }
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
