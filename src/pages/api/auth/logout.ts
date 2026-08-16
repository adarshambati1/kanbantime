import type { APIRoute } from 'astro';
import { COOKIE, sameOrigin } from '../../../lib/auth';

export const prerender = false;

/**
 * POST only, and same-origin only.
 *
 * As a GET this was a one-click CSRF: any third-party page could navigate you
 * here and sign you out. /api/auth/* is deliberately outside the middleware's
 * gate (it's how you get a session in the first place), so the origin check has
 * to happen here rather than being inherited.
 */
export const POST: APIRoute = async ({ request, cookies, url }) => {
  if (!sameOrigin(request, url.origin)) {
    return new Response(JSON.stringify({ error: 'bad origin' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  cookies.delete(COOKIE, { path: '/' });
  return new Response(null, { status: 303, headers: { location: '/login?error=out' } });
};
