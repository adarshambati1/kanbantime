import type { APIRoute } from 'astro';
import { grepNotes } from '../../../lib/notesDb';

export const prerender = false;

/**
 * Full-text search — the one search mode that can't be answered from the
 * client's local IndexedDB copy (FTS5 only exists server-side). Plain
 * listing/folder/date filters are done client-side in notesStore.ts instead.
 */
export const GET: APIRoute = async ({ url }) => {
  const q = url.searchParams.get('q')?.trim() ?? '';
  if (!q) return json({ notes: [] });

  const folder = url.searchParams.get('folder') ?? undefined;
  const fromMs = url.searchParams.get('from') ? Number(url.searchParams.get('from')) : undefined;
  const toMs = url.searchParams.get('to') ? Number(url.searchParams.get('to')) : undefined;

  try {
    const notes = await grepNotes(q, { folder, fromMs, toMs });
    return json({ notes });
  } catch (err) {
    console.error('notes search failed', err);
    return json({ error: 'search failed' }, 500);
  }
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
