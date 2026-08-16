import { defineMiddleware } from 'astro:middleware';
import { COOKIE, authorize, sameOrigin } from './lib/auth';

/**
 * Everything is gated except the login screen and the OAuth routes — this whole
 * deployment is the private app. /api/auth/* has to stay open, since that's how
 * a credential is obtained in the first place.
 */
const PROTECTED = [/^\/$/, /^\/api\/(sync|quick-add|list|prefs|agent)(\/|$)/];

const json = (data: unknown, status: number) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export const onRequest = defineMiddleware(async (ctx, next) => {
  const path = ctx.url.pathname;
  if (!PROTECTED.some((re) => re.test(path))) return next();

  const via = authorize(ctx.request, ctx.cookies.get(COOKIE)?.value);

  if (!via) {
    // API callers get a status they can act on; humans get sent to the form.
    if (path.startsWith('/api/')) return json({ error: 'unauthorized' }, 401);
    return ctx.redirect(`/login?next=${encodeURIComponent(path)}`, 302);
  }

  // CSRF: a cookie rides along on cross-site requests whether the user meant it
  // or not, so cookie-authenticated writes must prove they came from us.
  // SameSite=Lax already covers this; the origin check is the belt to its braces.
  // Bearer callers are exempt — Shortcuts and curl don't send Origin at all.
  if (via === 'cookie' && ctx.request.method !== 'GET' && ctx.request.method !== 'HEAD') {
    if (!sameOrigin(ctx.request, ctx.url.origin)) return json({ error: 'bad origin' }, 403);
  }

  return next();
});
