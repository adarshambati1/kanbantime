import type { APIRoute } from 'astro';
import { openTodos } from '../../lib/db';

export const prerender = false;

/**
 * "Hey Siri, what's on my list."
 *
 * Returns `spoken` as a ready-to-speak sentence so the Shortcut is two blocks:
 * Get Contents of URL -> Speak Text. Pass ?format=text to get bare text back.
 */
export const GET: APIRoute = async ({ url }) => {
  const todos = await openTodos();
  const titles = todos.map((t) => t.title).filter(Boolean);

  const spoken =
    titles.length === 0
      ? 'Your list is empty.'
      : titles.length === 1
        ? `One thing on your list: ${titles[0]}.`
        : `${titles.length} things on your list. ${titles.slice(0, 10).join('. ')}.`;

  if (url.searchParams.get('format') === 'text') {
    return new Response(spoken, {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  return new Response(JSON.stringify({ count: titles.length, todos: titles, spoken }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};
