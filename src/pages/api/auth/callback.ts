import type { APIRoute } from 'astro';
import { COOKIE, STATE_COOKIE, exchangeCode, isAllowed, issueSession } from '../../../lib/auth';

export const prerender = false;

const deny = (reason: string) =>
  new Response(null, { status: 302, headers: { location: `/login?error=${reason}` } });

export const GET: APIRoute = async ({ url, cookies }) => {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (url.searchParams.get('error')) return deny('cancelled');
  if (!code || !state) return deny('missing');

  // Verify against the cookie we set before leaving, then burn it.
  const raw = cookies.get(STATE_COOKIE)?.value;
  cookies.delete(STATE_COOKIE, { path: '/' });
  if (!raw) return deny('state');

  let expected: { state?: string; next?: string };
  try {
    expected = JSON.parse(raw);
  } catch {
    return deny('state');
  }
  if (!expected.state || expected.state !== state) return deny('state');

  const claims = await exchangeCode(code, new URL('/api/auth/callback', url.origin).href);
  if (!claims?.email) return deny('exchange');

  // The allowlist is the whole access-control model.
  if (!isAllowed(claims.email)) return deny('denied');

  const { value, maxAge } = issueSession(claims.email);
  cookies.set(COOKIE, value, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: url.protocol === 'https:',
    maxAge,
  });

  const next = expected.next && expected.next.startsWith('/') ? expected.next : '/todo';
  return new Response(null, { status: 302, headers: { location: next } });
};
