import type { APIRoute } from 'astro';
import { STATE_COOKIE, authUrl, newState, oauthConfigured } from '../../../lib/auth';

export const prerender = false;

/** Kick off the Google flow. */
export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  if (!oauthConfigured()) {
    return new Response(
      'OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_EMAILS and AUTH_SECRET. See the README.',
      { status: 500, headers: { 'content-type': 'text/plain' } },
    );
  }

  const next = url.searchParams.get('next') || '/todo';
  const state = newState();

  // The state cookie is what makes the callback verifiable: an attacker can
  // send you to a callback URL, but can't set this cookie on your browser.
  // `next` rides inside it so the callback can't be tricked into redirecting
  // somewhere we didn't choose.
  cookies.set(
    STATE_COOKIE,
    JSON.stringify({ state, next: next.startsWith('/') && !next.startsWith('//') ? next : '/todo' }),
    {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: url.protocol === 'https:',
      maxAge: 600,
    },
  );

  return redirect(authUrl(new URL('/api/auth/callback', url.origin).href, state), 302);
};
