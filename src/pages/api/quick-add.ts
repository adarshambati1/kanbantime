import type { APIRoute } from 'astro';
import { quickAdd } from '../../lib/db';

export const prerender = false;

/**
 * "Hey Siri, add to my list."
 *
 * An iOS Shortcut with Ask for Input -> Get Contents of URL (POST, bearer token)
 * hits this. Accepts JSON or a raw text body so the Shortcut can stay simple.
 */
export const POST: APIRoute = async ({ request }) => {
  const raw = await request.text();
  let title = '';

  try {
    const parsed = JSON.parse(raw);
    title = String(parsed?.title ?? parsed?.text ?? '');
  } catch {
    title = raw;
  }

  title = title.trim();
  if (!title) return json({ error: 'empty title' }, 400);
  if (title.length > 500) title = title.slice(0, 500);

  try {
    const todo = await quickAdd(title);
    return json({ ok: true, id: todo.id, title: todo.title, spoken: `Added ${todo.title}` });
  } catch (err) {
    console.error('quick-add failed', err);
    return json({ error: 'could not add' }, 500);
  }
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
